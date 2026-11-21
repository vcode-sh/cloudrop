// Spec §4 row 18 (M3-K7): jobs of 20 single and multipart files through start() while the proxy faults requests at
// random (resets mid-body, 503 SlowDown, latency), with real backoff waits. Every file must end done with its exact
// bytes, or failed with a code a fault of that kind documents. One job is aborted while its first run still sends,
// with one file already failed and holding its upload: abort() must free every upload and leave only the done files,
// besides the orphan M3-S14 accepts. The other retries with the faults off, which must finish every file (plan audit
// M9, C3).
// Run with `bun run test:chaos:soak`; set CLOUDROP_CHAOS_SEED to the seed in a test's title to run with the same
// files and the same fault stream. Requests draw from that stream in the order they reach the proxy, and parts run
// concurrently, so a replay gets the same mix of faults but not always the same fault on the same request: a red
// run prints the requests and faults it saw.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileOutcome, FileStatus, UploadJob, UploadResult } from "../client/types.ts";
import { MiB } from "../rules.ts";
import { BAD_SIGNATURE } from "../testing/chaos-bodies.ts";
import { chaosStorage, rustfsEndpoint } from "../testing/chaos-bucket.ts";
import { chaosFile, useChaosFixture } from "../testing/chaos-fixture.ts";
import type { ChaosRandom } from "../testing/chaos-proxy.ts";

const chaos = useChaosFixture();

// The fixture stubs Math.random to 0 for rows that need exact timing windows (M3-K3). The soak waits real jitter, so a
// bug that needs time between attempts, such as a slot freed or a URL renewed during a backoff, can show here.
beforeEach(() => {
  vi.mocked(Math.random).mockRestore();
});

function soakSeed(): number {
  const given = process.env.CLOUDROP_CHAOS_SEED;
  if (given === undefined) return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const seed = Number(given);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error(`CLOUDROP_CHAOS_SEED must be a whole number from 0 to 4294967295, not "${given}".`);
  }
  return seed;
}

// In the titles, so a red run names it in every reporter. The default reporter lists no passing test, so the nightly
// job passes --silent=false to log it on a green night too.
const seed = soakSeed();

// A red run prints what reached the bucket: labels, faults and byte counts only, never a URL or a header. Hooks run
// as a stack, so this runs before the fixture's reset clears the log; onTestFailed would run after it.
afterEach(({ task }) => {
  if (task.result?.state !== "fail") return;
  const trace = chaos.proxy.log().map((e) => `${e.label} ${e.fault ?? "-"} ${e.outcome} ${e.bytesIn}B`);
  console.error(`Chaos soak seed ${seed}, requests that reached the bucket:\n${trace.join("\n")}`);
});

// 20 files, as many as the route takes per /upload. Single PUTs up to the fixture's 8 MiB threshold; multipart files
// whose last part is one byte, exactly 8 MiB, or anything between.
const SINGLE = [0, 1, 65_536, MiB, 2 * MiB, 3 * MiB + 7, 4 * MiB, 5 * MiB + 3, 7 * MiB, 8 * MiB];
const MULTIPART = [8 * MiB + 1, 24 * MiB + 1, ...[9, 10, 12, 13, 16, 17, 20, 21].map((mib) => mib * MiB)];
const SIZES = [...SINGLE, ...MULTIPART];

// A rate high enough that some files run out of their six attempts, low enough that most of a job gets through.
const FAULTS: Omit<ChaosRandom, "seed"> = { resetRate: 0.35, busyRate: 0.2, latencyMs: [0, 50] };

// What a file may fail with under these faults, and the retryable each code documents: a PUT that got no answer
// (spec §6.2), SlowDown from the bucket or relayed by the server, and the server's own storage call cut (storageFailure).
// A file whose storage call failed in /upload gets a rejected ticket and asks /upload again within its attempts
// (M3-U92); it fails with the refusal once they are spent, and retry() asks /upload again for it (M3-U31). A file that
// holds a ticket keeps it on retry for each of these codes.
const FAULT_ERRORS: Record<string, boolean> = { NETWORK_ERROR: true, RATE_LIMITED: true, STORAGE_ERROR: true };

/** Starts a job of the soak's files under the seeded faults; `files[i]` is the file of `SIZES[i]`. */
function startSoakJob(): { files: File[]; job: UploadJob<null> } {
  const files = SIZES.map((size, index) => chaosFile(size, seed + index + 1));
  chaos.proxy.random({ seed, ...FAULTS });
  return { files, job: chaos.client().start("files", files) };
}

/**
 * The per-file oracle: a done file holds its exact bytes, a failed or aborted one has a code of `endings` with its
 * documented retryable, ABORTED exactly when it ended aborted, and no storage text in its message (spec §7). Returns
 * the outcomes, in file order.
 */
async function expectOutcomes(
  files: File[],
  result: UploadResult<null>,
  endings: Record<string, boolean> = FAULT_ERRORS,
): Promise<FileOutcome<null>[]> {
  const outcomes = result.data?.files ?? [];
  expect(outcomes.map((outcome) => outcome.name)).toEqual(files.map((file) => file.name));
  const wrong = outcomes.flatMap((outcome) => {
    if (outcome.status === "done") return [];
    const { code, retryable, message } = outcome.error;
    const listed = endings[code] === retryable && (outcome.status === "aborted") === (code === "ABORTED");
    if (listed && !/SlowDown|<|127\.0\.0\.1/.test(message)) return [];
    return [{ name: outcome.name, status: outcome.status, code, retryable, message }];
  });
  expect(wrong).toEqual([]);
  for (const [index, file] of files.entries()) {
    const outcome = outcomes[index];
    if (outcome?.status === "done") await chaos.expectStored(outcome.result.file.key, file);
  }
  return outcomes;
}

const doneKeys = (outcomes: readonly FileOutcome<null>[]) =>
  outcomes.flatMap((outcome) => (outcome.status === "done" ? [outcome.result.file.key] : []));

/** Without this, a soak whose faults never fired would pass as a clean run. */
function expectFaultsInjected(): void {
  const faulted = chaos.proxy.log().filter((entry) => entry.fault === "reset" || entry.fault === "answer");
  expect(faulted.length, "requests the proxy reset or answered 503").toBeGreaterThan(0);
}

const settled: readonly FileStatus[] = ["done", "failed", "aborted"];

/** The sizes of the objects under the prefix outside `kept`, read from RustFS directly. */
async function orphanSizes(kept: readonly string[]): Promise<number[]> {
  const storage = chaosStorage(rustfsEndpoint());
  const left = (await chaos.objectsLeft()).filter((key) => !kept.includes(key));
  return Promise.all(left.map(async (key) => (await storage.head(key)).data?.size ?? -1));
}

/** The orphans no single file's whole-body cut PUT accounts for, each cut PUT accounting for one orphan at most. */
function unexplainedOrphans(sizes: readonly number[], cutBytes: readonly number[]): number[] {
  const unclaimed = [...cutBytes];
  return sizes.filter((size) => {
    const claim = unclaimed.indexOf(size);
    if (claim === -1 || !SINGLE.includes(size)) return true;
    unclaimed.splice(claim, 1);
    return false;
  });
}

test(`abort() while a seeded faulty run still sends frees every upload, a failed file's too, and keeps the done files (seed ${seed})`, async () => {
  // The first part 3 to arrive is refused for good: its file fails at once and keeps its upload for retry() (M3-U31).
  chaos.proxy.set([
    {
      match: { kind: "presigned", operation: "UploadPart", part: 3 },
      fault: { kind: "answer", status: 403, body: BAD_SIGNATURE },
    },
  ]);
  const { files, job } = startSoakJob();
  const snapshot = () => job.getSnapshot().files;
  // Up to 30 s: faults and real backoff waits slow the run down.
  await vi.waitFor(
    () => {
      expect(chaos.appRequests()).toContain("POST /complete 200");
      expect(snapshot().map((file) => file.error?.code)).toContain("UPLOAD_REJECTED");
    },
    { timeout: 30_000, interval: 10 },
  );
  // Off before the abort, or a faulted /abort leaves its upload behind (audit M9).
  chaos.proxy.random(null);
  const sending = snapshot().filter((file) => !settled.includes(file.status)).length;
  job.abort();

  const outcomes = await expectOutcomes(files, await job.done, {
    ...FAULT_ERRORS,
    UPLOAD_REJECTED: false,
    ABORTED: false,
  });
  expectFaultsInjected();
  expect(sending, "files still sending when abort() ran").toBeGreaterThan(0);
  const codes = outcomes.flatMap((outcome) => (outcome.status === "done" ? [] : [outcome.error.code]));
  expect(codes.filter((code) => code === "UPLOAD_REJECTED")).toEqual(["UPLOAD_REJECTED"]);
  // abort() frees the refused file's kept upload (M3-U32) and every running file's ticket (M3-U38); a failed file's
  // /abort runs in the background. The only object it may leave outside the done files is that of a single PUT it cut
  // after all its bytes reached the bucket, which can land after its /abort's HEAD (M3-S14). The single files' sizes
  // all differ, so an orphan's size names its file, and that file's PUT must be one the proxy saw cut whole.
  const keys = doneKeys(outcomes);
  let orphans: number[] = [];
  await vi.waitFor(
    async () => {
      await chaos.expectNoUploadsLeft();
      orphans = await orphanSizes(keys);
      const cutWhole = chaos.proxy
        .log()
        .filter((entry) => entry.label === "PUT object" && entry.outcome === "aborted")
        .map((entry) => entry.bytesIn);
      expect(unexplainedOrphans(orphans, cutWhole), "objects outside the done files no cut PUT explains").toEqual([]);
    },
    { timeout: 10_000, interval: 50 },
  );
  const statuses = outcomes.map((outcome) => (outcome.status === "done" ? "done" : "aborted"));
  expect(snapshot().map((file) => file.status)).toEqual(statuses);
  const aborted = statuses.filter((status) => status === "aborted").length;
  console.info(
    `Chaos soak seed ${seed}: ${sending} still sending at abort(), ${aborted} aborted, ${orphans.length} orphans.`,
  );
});

test(`retry() with the faults off finishes every file a seeded faulty run failed (seed ${seed})`, async () => {
  const { files, job } = startSoakJob();
  const first = await expectOutcomes(files, await job.done);
  expectFaultsInjected();
  chaos.proxy.random(null);

  const second = await job.retry();

  expect(second.error).toBeNull();
  const keys = doneKeys(await expectOutcomes(files, second));
  // A file with a kept upload finished on that ticket (M11-R80); one refused at /upload never had an upload; and one
  // whose ticket the retry replaced gave it up first (M11-R89). So no upload is left open at all.
  await chaos.expectNoUploadsLeft();
  expect((await chaos.objectsLeft()).toSorted()).toEqual(keys.toSorted());
  console.info(
    `Chaos soak seed ${seed}: ${files.length - doneKeys(first).length} failed at first, all done after retry.`,
  );
});
