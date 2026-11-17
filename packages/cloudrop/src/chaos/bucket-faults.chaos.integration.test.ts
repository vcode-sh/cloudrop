// Chaos rows 4-8 (design spec §4): the proxy answers a presigned PUT itself, with the status and body R2 or RustFS
// would send, so the bucket never sees that attempt: a 429 with Retry-After, a 503 and a 500 on the single PUT, and
// readable 403s (a bad signature, an expired URL in R2's and RustFS's words, ruling M3-K5). Run with
// `bun run test:chaos`.
import { expect, test, vi } from "vitest";
import {
  BAD_SIGNATURE,
  INTERNAL_ERROR,
  R2_EXPIRED,
  R2_THROTTLED,
  RUSTFS_EXPIRED,
  SLOW_DOWN,
} from "../testing/chaos-bodies.ts";
import { chaosFile, MULTIPART_FILE_SIZE, SINGLE_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";
import type { ChaosFault, ChaosMatch } from "../testing/chaos-proxy.ts";

const chaos = useChaosFixture();

/** Text of the bodies (chaos-bodies.ts) that a client message must never repeat (spec §7). */
const STORAGE_TEXT = /<|internal error|signature we calculated/i;

const SINGLE_PUT: ChaosMatch = { operation: "PutObject" };
const PART_1: ChaosMatch = { operation: "UploadPart", part: 1 };
const answer = (status: number, body: string, headers?: Record<string, string>): ChaosFault => ({
  kind: "answer",
  status,
  body,
  ...(headers && { headers }),
});

/** Milliseconds from the end of the first `label` request to the start of the second, as the proxy saw them. */
function gapBetween(label: string): number {
  const [first, second] = chaos.proxy.log().filter((entry) => entry.label === label);
  return (second?.startMs ?? Number.NaN) - (first?.endMs ?? Number.NaN);
}

test("row 4: a part answered 429 with Retry-After: 2 is sent again 2 s later with the same URL, and stored", async () => {
  const file = chaosFile(MULTIPART_FILE_SIZE);
  chaos.proxy.set([{ match: PART_1, fault: answer(429, R2_THROTTLED, { "retry-after": "2" }) }]);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  // RATE_LIMITED waits and retries without a renewal (decision S10, M3-U25).
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 200"]);
  const requests = chaos.bucketRequests();
  expect(requests.slice(1, 4).toSorted()).toEqual(["PUT part 1 429", "PUT part 2 200", "PUT part 3 200"]);
  expect([requests[0], ...requests.slice(4)]).toEqual([
    "CreateMultipartUpload 200",
    "PUT part 1 200",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  // Jitter is 0 in this lane, so only the readable Retry-After makes the client wait (decision S9, audit M10).
  expect(gapBetween("PUT part 1")).toBeGreaterThanOrEqual(2000);
});

test("row 5: a single PUT answered 503 once is sent again and stored, with a 200 since the 503 never reached the bucket", async () => {
  const file = chaosFile(SINGLE_FILE_SIZE);
  chaos.proxy.set([{ match: SINGLE_PUT, fault: answer(503, SLOW_DOWN) }]);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 200"]);
  expect(chaos.bucketRequests()).toEqual(["PUT object 503", "PUT object 200", "HeadObject 200"]);
});

test("row 6: a single PUT answered 500 on all 6 attempts fails with a retryable STORAGE_ERROR and stores nothing", async () => {
  chaos.proxy.set([{ match: { ...SINGLE_PUT, nth: "every" }, fault: answer(500, INTERNAL_ERROR) }]);

  const { data, error } = await chaos.client().upload("files", chaosFile(SINGLE_FILE_SIZE));

  expect(data).toBeNull();
  expect([error?.code, error?.retryable]).toEqual(["STORAGE_ERROR", true]);
  expect(error?.message).not.toMatch(STORAGE_TEXT);
  // upload() answers before its /abort lands (decision S15); its answer comes after its last storage call.
  await chaos.waitForApp("POST /abort 200");
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /abort 200"]);
  expect(chaos.bucketRequests()).toEqual([
    "PUT object 500",
    "PUT object 500",
    "PUT object 500",
    "PUT object 500",
    "PUT object 500",
    "PUT object 500",
    "HeadObject 404",
  ]);
  expect(await chaos.objectsLeft()).toEqual([]);
});

test("row 7: a part refused 403 SignatureDoesNotMatch fails at once; retry() takes a new ticket and leaves the first upload open", async () => {
  const file = chaosFile(MULTIPART_FILE_SIZE);
  chaos.proxy.set([{ match: PART_1, fault: answer(403, BAD_SIGNATURE) }]);
  const job = chaos.client().start("files", [file]);

  const failed = await job.done;

  // Rejected with no renewal and no second attempt (decision S10); parts 2 and 3 were already sent and finish (M3-U18).
  expect([failed.error?.code, failed.error?.retryable]).toEqual(["UPLOAD_REJECTED", false]);
  expect(failed.error?.message).not.toMatch(STORAGE_TEXT);
  expect(chaos.appRequests()).toEqual(["POST /upload 200"]);
  const requests = chaos.bucketRequests();
  expect(requests[0]).toBe("CreateMultipartUpload 200");
  expect(requests.slice(1).toSorted()).toEqual(["PUT part 1 403", "PUT part 2 200", "PUT part 3 200"]);
  const first = await chaos.uploadsLeft();
  expect(first.length).toBe(1);

  chaos.proxy.set([]);
  chaos.proxy.clearLog();
  const retried = await job.files[0]?.retry();

  // UPLOAD_REJECTED needs a new ticket (M3-U31): a new upload under a new key, every part sent again.
  expect(retried?.status).toBe("done");
  const key = retried?.status === "done" ? retried.result.file.key : "";
  expect([key.startsWith(chaos.prefix), key === first[0]?.key]).toEqual([true, false]);
  await chaos.expectStored(key, file);
  expect(chaos.appRequests().slice(1)).toEqual(["POST /upload 200", "POST /complete 200"]);
  const again = chaos.bucketRequests();
  expect(again.slice(1, 4).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 200", "PUT part 3 200"]);
  expect([again[0], ...again.slice(4)]).toEqual([
    "CreateMultipartUpload 200",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  // No /abort for the old ticket (M3-U55): its upload is left to the bucket's lifecycle rule (audit C3).
  expect(await chaos.uploadsLeft()).toEqual(first);
});

test.each([
  { name: "R2's 403 ExpiredRequest", body: R2_EXPIRED },
  { name: "RustFS's 403 AccessDenied", body: RUSTFS_EXPIRED },
])("row 8: a single PUT refused once with $name is renewed and sent again at once, and stored", async ({ body }) => {
  // With jitter near its ceiling, a retry that waited would wait about 500 ms (decision S9): an expiry must not wait.
  vi.spyOn(Math, "random").mockReturnValue(0.999);
  const file = chaosFile(SINGLE_FILE_SIZE);
  chaos.proxy.set([{ match: SINGLE_PUT, fault: answer(403, body) }]);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  // One renewal, then the new URL at once (decision S11).
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /complete 200"]);
  expect(chaos.bucketRequests()).toEqual(["PUT object 403", "PUT object 200", "HeadObject 200"]);
  expect(gapBetween("PUT object")).toBeLessThan(250);
});
