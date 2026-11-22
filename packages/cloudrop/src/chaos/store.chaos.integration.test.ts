// Chaos rows with a database store (M5 spec §8): the server keeps a row per upload in node:sqlite through sqlStore.
// An /upload answer lost on the way is superseded by the retry that carries its idempotency key. Answers to /complete
// lost after the server committed, a deadline that passes while onComplete still runs, and a storage acknowledgement
// lost on the way still run onComplete exactly once and leave the owner's usage exact; a revoke stops an upload at its
// next call; the sweep after closed tabs leaves no orphan object and no open upload.
// Run with `bun run test:chaos`.
import { expect, test, vi } from "vitest";
import { chaosFile, MULTIPART_FILE_SIZE, SINGLE_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";
import { CHAOS_OWNER } from "../testing/chaos-server.ts";

const chaos = useChaosFixture({ store: true });

const BUSY = {
  error: {
    code: "SERVER_ERROR",
    message: "Another request is completing this upload. Try again in a moment.",
    retryable: true,
  },
};

/** The file completed once: one onComplete, one afterComplete, its row completed and its bytes counted once. */
async function expectCompletedOnce(id: string, size: number) {
  expect(chaos.store.completions()).toEqual({ [id]: 1 });
  expect(chaos.store.afterCompletions()).toEqual({ [id]: 1 });
  expect((await chaos.store.raw.files()).map(({ id, status }) => ({ id, status }))).toEqual([
    { id, status: "completed" },
  ]);
  expect(await chaos.store.raw.usage()).toMatchObject([
    { owner: CHAOS_OWNER, reservedBytes: 0, activeBytes: size, files: 1 },
  ]);
}

test("an /upload answer lost to a reset: the retry with the same key supersedes the lost attempt, and usage counts the file once", async () => {
  chaos.faultApp([{ call: "upload", fault: { kind: "reset" } }]);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  expect(chaos.appRequests()).toEqual(["POST /upload 200 reset", "POST /upload 200", "POST /complete 200"]);
  // Without the key, the lost attempt's row would still hold its bytes as reserved until the sweep expired it.
  const rows = await chaos.store.raw.files();
  expect(rows).toHaveLength(2);
  expect(Object.fromEntries(rows.map(({ id, status }) => [id === data?.file.id ? "retry" : "lost", status]))).toEqual({
    lost: "aborted",
    retry: "completed",
  });
  expect(await chaos.store.raw.usage()).toMatchObject([
    { owner: CHAOS_OWNER, reservedBytes: 0, activeBytes: file.size, files: 1 },
  ]);
  expect(await chaos.objectsLeft()).toEqual([data?.file.key]);
});

test("a /complete answer lost to a reset after the commit: the retry replays the stored answer with no storage call", async () => {
  chaos.faultApp([{ call: "complete", fault: { kind: "reset" } }]);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await expectCompletedOnce(data?.file.id ?? "", file.size);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 200 reset", "POST /complete 200"]);
  // One HEAD: the replay answers from the row.
  expect(chaos.bucketRequests()).toEqual(["PUT object 200", "HeadObject 200"]);
});

test("a gateway 503 in place of a committed /complete answer: the retry replays, the multipart upload is completed once", async () => {
  chaos.faultApp([{ call: "complete", fault: { kind: "gateway", status: 503 } }]);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  await expectCompletedOnce(data?.file.id ?? "", file.size);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 200 then 503", "POST /complete 200"]);
  expect(chaos.bucketRequests().slice(4)).toEqual(["ListParts 200", "CompleteMultipartUpload 200"]);
});

test("a deadline that passes while onComplete runs: the overlapping retries are busy, then replay, and onComplete ran once", async () => {
  const held = chaos.store.holdNextCompletion();
  chaos.faultApp([{ call: "complete", fault: { kind: "late", until: held.reached } }]);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const uploaded = chaos.client().upload("files", file);
  // The client gives up on the first /complete once its onComplete runs, and asks again while it still does.
  await chaos.waitForApp("POST /complete 500");
  held.release();
  const { data, error } = await uploaded;

  expect(error).toBeNull();
  await expectCompletedOnce(data?.file.id ?? "", file.size);
  expect(chaos.appRequests()).toEqual([
    "POST /upload 200",
    "POST /complete 500",
    "POST /complete 200 late",
    "POST /complete 200",
  ]);
  expect(chaos.appErrors()).toEqual([BUSY]);
  // Busy and the replay both answer from the row, before any storage call.
  expect(chaos.bucketRequests()).toEqual(["PUT object 200", "HeadObject 200"]);
});

test("a CompleteMultipartUpload answer lost after the storage completed: the retry finds the object and runs onComplete once", async () => {
  chaos.proxy.set([
    {
      match: { kind: "server", operation: "CompleteMultipartUpload" },
      fault: { kind: "truncate", at: "beforeHeaders" },
    },
  ]);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  await expectCompletedOnce(data?.file.id ?? "", file.size);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 502", "POST /complete 200"]);
  expect(chaos.bucketRequests().slice(4)).toEqual([
    "ListParts 200",
    "CompleteMultipartUpload reset",
    "ListParts 404",
    "HeadObject 200",
  ]);
});

test("a revoke while a part is on its way stops the upload at its next call, and its /abort leaves nothing", async () => {
  chaos.proxy.set([{ match: { operation: "UploadPart", part: 2 }, fault: { kind: "blackhole" } }]);
  const file = chaosFile(MULTIPART_FILE_SIZE);

  const uploaded = chaos.client().upload("files", file);
  await vi.waitFor(() => expect(chaos.bucketRequests()).toContain("PUT part 2 held"), { timeout: 10_000 });
  expect(await chaos.api.revokeUploads(CHAOS_OWNER)).toEqual({ data: { revoked: 1 }, error: null });
  chaos.proxy.release();
  const { data, error } = await uploaded;

  expect(data).toBeNull();
  expect([error?.code, error?.retryable]).toEqual(["UPLOAD_EXPIRED", false]);
  await chaos.waitForApp("POST /abort 200");
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 410", "POST /abort 200"]);
  expect(chaos.store.completions()).toEqual({});
  await chaos.expectNoUploadsLeft();
  expect(await chaos.objectsLeft()).toEqual([]);
  expect((await chaos.store.raw.files()).map(({ status }) => status)).toEqual(["aborted"]);
  expect(await chaos.store.raw.usage()).toMatchObject([
    { owner: CHAOS_OWNER, reservedBytes: 0, activeBytes: 0, files: 0 },
  ]);
});

test("the sweep after closed tabs removes the orphan object and the open upload, and keeps the completed file", async () => {
  const kept = chaosFile(SINGLE_FILE_SIZE, 1);
  const done = await chaos.client().upload("files", kept);
  expect(done.error).toBeNull();
  // A single PUT lands in the bucket but its answer is late, and a multipart upload holds its part 2; then the tab
  // closes, so neither /complete nor /abort is ever sent.
  chaos.proxy.set([
    { match: { operation: "PutObject" }, fault: { kind: "delay", ms: 5000, when: "after" } },
    { match: { operation: "UploadPart", part: 2 }, fault: { kind: "blackhole" } },
  ]);
  void chaos.client().upload("files", chaosFile(SINGLE_FILE_SIZE, 2));
  void chaos.client().upload("files", chaosFile(MULTIPART_FILE_SIZE, 3));
  await vi.waitFor(
    async () => {
      expect(await chaos.objectsLeft()).toHaveLength(2);
      expect(chaos.bucketRequests()).toContain("PUT part 2 held");
    },
    { timeout: 10_000 },
  );
  chaos.closeTab();
  chaos.proxy.release();
  expect(await chaos.uploadsLeft()).toHaveLength(1);

  // A day and an hour later: past both tokens' deadline and the sweep's default hour of grace.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 25 * 3_600_000 + 60_000 });
  const swept = await chaos.api.sweep();
  vi.useRealTimers();

  expect(swept).toEqual({ data: { expired: 2, cleaned: 0, failed: 0, reported: [], cursor: null }, error: null });
  expect(await chaos.objectsLeft()).toEqual([done.data?.file.key]);
  await chaos.expectNoUploadsLeft();
  expect(chaos.store.completions()).toEqual({ [done.data?.file.id ?? ""]: 1 });
  expect((await chaos.store.raw.files()).map(({ status }) => status).toSorted()).toEqual([
    "completed",
    "expired",
    "expired",
  ]);
  expect(await chaos.store.raw.usage()).toMatchObject([
    { owner: CHAOS_OWNER, reservedBytes: 0, activeBytes: kept.size, files: 1 },
  ]);
});
