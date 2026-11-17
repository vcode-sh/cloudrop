// Spec §4 row 18 (M3-K7): jobs of 20 single and multipart files through start() while the proxy faults requests at
// random (resets mid-body, 503 SlowDown, latency). Every file must end done with its exact bytes, or failed with a code
// a fault of that kind documents. One job retries under the same faults, then abort() must leave only the done files;
// the other retries with the faults off, which must finish every file (plan audit M9, C3).
// Run with `bun run test:chaos:soak`; set CLOUDROP_CHAOS_SEED to the seed in a test's title to run with the same
// files and the same fault stream. Requests draw from that stream in the order they reach the proxy, and parts run
// concurrently, so a replay gets the same mix of faults but not always the same fault on the same request: a red
// run prints the requests and faults it saw.
import { afterEach, expect, test, vi } from "vitest";
import type { FileOutcome, UploadJob, UploadResult } from "../client/types.ts";
import { MiB } from "../rules.ts";
import { chaosFile, useChaosFixture } from "../testing/chaos-fixture.ts";
import type { ChaosRandom } from "../testing/chaos-proxy.ts";

const chaos = useChaosFixture();

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
// Most come from /upload: a file whose storage call failed gets a rejected ticket and fails at once (M2-D13), and
// retry() asks /upload again for it (M3-U31). A file that holds a ticket keeps it on retry for each of these codes.
const FAULT_ERRORS: Record<string, boolean> = { NETWORK_ERROR: true, RATE_LIMITED: true, STORAGE_ERROR: true };

/** Starts a job of the soak's files under the seeded faults; `files[i]` is the file of `SIZES[i]`. */
function startSoakJob(): { files: File[]; job: UploadJob<null> } {
  const files = SIZES.map((size, index) => chaosFile(size, seed + index + 1));
  chaos.proxy.random({ seed, ...FAULTS });
  return { files, job: chaos.client().start("files", files) };
}

/**
 * The per-file oracle: a done file holds its exact bytes, a failed one has a listed code with its documented retryable
 * and no storage text in its message (spec §7). Returns the outcomes, in file order.
 */
async function expectOutcomes(files: File[], result: UploadResult<null>): Promise<FileOutcome<null>[]> {
  const outcomes = result.data?.files ?? [];
  expect(outcomes.map((outcome) => outcome.name)).toEqual(files.map((file) => file.name));
  const wrong = outcomes.flatMap((outcome) => {
    if (outcome.status === "done") return [];
    const { code, retryable, message } = outcome.error;
    const listed = outcome.status === "failed" && FAULT_ERRORS[code] === retryable;
    return listed && !/SlowDown|<|127\.0\.0\.1/.test(message) ? [] : [{ name: outcome.name, code, retryable, message }];
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

test(`retry() and abort() under seeded faults leave each file whole or failed retryably, and only done files stored (seed ${seed})`, async () => {
  const { files, job } = startSoakJob();
  const first = await expectOutcomes(files, await job.done);
  expectFaultsInjected();
  // A done file's upload is completed; an upload still open under its key belongs to nobody.
  const firstDone = doneKeys(first);
  expect((await chaos.uploadsLeft()).filter((upload) => firstDone.includes(upload.key))).toEqual([]);

  const outcomes = await expectOutcomes(files, await job.retry());
  // Off before the aborts, or a faulted /abort leaves its upload behind (audit M9).
  chaos.proxy.random(null);
  job.abort();

  // abort() frees each failed file's kept upload (M3-U32). No retry above took a new ticket over a kept upload, since
  // every listed code keeps it (M3-U31), so M3-U55 leaves nothing either: any upload still open is a leak.
  await vi.waitFor(() => chaos.expectNoUploadsLeft(), { timeout: 10_000, interval: 50 });
  expect((await chaos.objectsLeft()).toSorted()).toEqual(doneKeys(outcomes).toSorted());
  const statuses = outcomes.map((outcome) => (outcome.status === "done" ? "done" : "aborted"));
  expect(job.getSnapshot().files.map((file) => file.status)).toEqual(statuses);
  const aborted = statuses.filter((status) => status === "aborted").length;
  console.info(`Chaos soak seed ${seed}: ${files.length - firstDone.length} failed at first, ${aborted} aborted.`);
});

test(`retry() with the faults off finishes every file a seeded faulty run failed (seed ${seed})`, async () => {
  const { files, job } = startSoakJob();
  const first = await expectOutcomes(files, await job.done);
  expectFaultsInjected();
  chaos.proxy.random(null);

  const second = await job.retry();

  expect(second.error).toBeNull();
  const keys = doneKeys(await expectOutcomes(files, second));
  // A file with a kept upload finished on that ticket (M3-U31); one refused at /upload never had an upload. So M3-U55
  // leaves nothing, and no upload is left open at all.
  await chaos.expectNoUploadsLeft();
  expect((await chaos.objectsLeft()).toSorted()).toEqual(keys.toSorted());
  console.info(
    `Chaos soak seed ${seed}: ${files.length - doneKeys(first).length} failed at first, all done after retry.`,
  );
});
