// Spec §4 row 18 (M3-K7): a job of single and multipart files through start() while the proxy faults requests at
// random (resets mid-body, 503 SlowDown, latency), then job.retry() with the faults off. Every file must end done with
// its exact bytes, or failed with a code a fault of that kind documents; after the retry every file is done and the
// prefix holds the files and nothing else (plan audit M9, C3). Run with `bun run test:chaos:soak`; replay a night's
// run with the seed it printed: `CLOUDROP_CHAOS_SEED=<seed> bun run test:chaos:soak`.
import { expect, test } from "vitest";
import type { FileOutcome } from "../client/types.ts";
import { MiB } from "../rules.ts";
import { chaosStorage, rustfsEndpoint } from "../testing/chaos-bucket.ts";
import { chaosFile, useChaosFixture } from "../testing/chaos-fixture.ts";

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

// Single PUTs up to the 8 MiB threshold, and multipart files whose last part is one byte, exactly 8 MiB, or 4 MiB.
const SIZES = [0, 1, 65_536, MiB, 3 * MiB + 7, 8 * MiB, 8 * MiB + 1, 16 * MiB, 20 * MiB, 24 * MiB + 1, 12 * MiB];

// A rate high enough that some files run out of their six attempts, low enough that most of a job gets through.
const FAULTS = { resetRate: 0.35, busyRate: 0.2, latencyMs: [0, 50] as [number, number] };

// What a file may fail with under these faults, and the retryable each code documents: a PUT that got no answer
// (spec §6.2), SlowDown from the bucket or relayed by the server, and the server's own storage call cut (storageFailure).
const FAULT_ERRORS: Record<string, boolean> = { NETWORK_ERROR: true, RATE_LIMITED: true, STORAGE_ERROR: true };

/** The fixture's expectStored reads bytes 0 to size - 1, a range an empty object lacks; its size is all it holds. */
async function expectStored(key: string, file: File): Promise<void> {
  if (file.size > 0) return chaos.expectStored(key, file);
  const head = await chaosStorage(rustfsEndpoint()).head(key);
  expect(head.data?.size, `the size stored under ${key}`).toBe(0);
}

/** The outcomes that break the oracle, with what was wrong, so a red run names each file. */
function unexpectedFailures(outcomes: readonly FileOutcome<null>[]) {
  return outcomes.flatMap((outcome) => {
    if (outcome.status === "done") return [];
    const { code, retryable, message } = outcome.error;
    const listed = outcome.status === "failed" && FAULT_ERRORS[code] === retryable;
    // Storage text never reaches a message (spec §7): no S3 error code, XML or bucket address.
    const clean = !/SlowDown|<|127\.0\.0\.1/.test(message);
    return listed && clean ? [] : [{ name: outcome.name, status: outcome.status, code, retryable, message }];
  });
}

test("a seeded job under random faults ends each file done with its bytes or failed retryably, and retry() finishes them all", async () => {
  const seed = soakSeed();
  console.info(`Chaos soak seed ${seed}. Replay: CLOUDROP_CHAOS_SEED=${seed} bun run test:chaos:soak`);
  const files = SIZES.map((size, index) => chaosFile(size, seed + index + 1));
  chaos.proxy.random({ seed, ...FAULTS });
  const job = chaos.client().start("files", files);
  const first = await job.done;
  // Off before anything else reaches the bucket, so the oracle and the retry run on a clean network (audit M9).
  chaos.proxy.random(null);

  const outcomes = first.data?.files ?? [];
  expect(outcomes.map((outcome) => outcome.name)).toEqual(files.map((file) => file.name));
  expect(unexpectedFailures(outcomes)).toEqual([]);
  const failed = outcomes.flatMap((outcome, index) => (outcome.status === "done" ? [] : [index]));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "done") await expectStored(outcome.result.file.key, files[index] as File);
  }
  // A failed multipart file keeps its ticket's upload open for retry() (§4.7); any more is an upload nobody owns.
  const keptForRetry = await chaos.uploadsLeft();
  const failedMultipart = failed.filter((index) => (SIZES[index] as number) > 8 * MiB);
  expect(keptForRetry.length).toBeLessThanOrEqual(failedMultipart.length);

  const second = await job.retry();

  expect(second.error).toBeNull();
  const keys = (second.data?.files ?? []).map((outcome) => (outcome.status === "done" ? outcome.result.file.key : ""));
  expect(keys.filter((key) => !key.startsWith(chaos.prefix))).toEqual([]);
  for (const index of failed) await expectStored(keys[index] as string, files[index] as File);
  // A retry that took a new ticket leaves the first one's upload to the lifecycle rule (M3-U55, audit C3).
  await chaos.expectNoUploadsLeft({ allow: keptForRetry.map((upload) => upload.key) });
  expect((await chaos.objectsLeft()).toSorted()).toEqual(keys.toSorted());

  const codes = outcomes.flatMap((outcome) => (outcome.status === "done" ? [] : [outcome.error.code]));
  console.info(
    `Chaos soak seed ${seed}: ${files.length} files, ${codes.length} failed at first (${codes.join(", ")}).`,
  );
});
