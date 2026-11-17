// Chaos rows 11 and 17 (design spec §4): a slow link that keeps moving, and the automatic pool under 429s. Parts are
// 8 MiB except the last (plan audit C2), so each row picks a file whose parts fit its timing. Run with
// `bun run test:chaos`.
import { expect, test } from "vitest";
import { MiB } from "../rules.ts";
import { chaosFile, useChaosFixture } from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

const KiB = 1024;

/**
 * Row 11: parts of 8 and 1 MiB. Part 2 at 32 KiB/s takes 32 s: longer than the bare 30 s stall, so only the size's
 * share of the fetch allowance (30 000 ms + 1 MiB at 102.4 B/ms = 40 240 ms, M3-U27) keeps it alive. The design's
 * 64 KiB/s would take 16 s and pass even with no size share at all.
 */
test("a part still moving after 30 s, inside 30 s plus its size at 100 KiB/s, is not cut, and is sent once", {
  timeout: 50_000,
}, async () => {
  chaos.proxy.set([
    { match: { kind: "presigned", part: 2, nth: "every" }, fault: { kind: "throttle", bytesPerSecond: 32 * KiB } },
  ]);
  const file = chaosFile(9 * MiB);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  const requests = chaos.bucketRequests();
  expect([requests[0], ...requests.slice(3)]).toEqual([
    "CreateMultipartUpload 200",
    "ListParts 200",
    "CompleteMultipartUpload 200",
  ]);
  expect(requests.slice(1, 3).toSorted()).toEqual(["PUT part 1 200", "PUT part 2 200"]);
  const slow = chaos.proxy.log().find((entry) => entry.label === "PUT part 2");
  expect((slow?.endMs ?? 0) - (slow?.startMs ?? 0)).toBeGreaterThanOrEqual(32_000);
});

// R2 throttles with 429 and the S3 code ServiceUnavailable (r2-spike-findings.md, Q9).
const BUSY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code><Message>Reduce your concurrent request rate for the same object.</Message></Error>';
const busy = { kind: "answer", status: 429, body: BUSY } as const;

/**
 * Row 17: four parts of 8 MiB, all in flight at once (the automatic pool starts at 4 slots, a file sends 4 parts).
 * Parts 1 and 2 are answered 429 in one window, while parts 3 and 4 hold their slots: part 3 for 1 s, part 4 and every
 * retry for 2 s, so the slots free one at a time and each retry's start is a full second from any other PUT's end.
 * One halving per window (M3-U24, M3-U25) leaves 2 slots: retry 1 starts when part 3 ends, beside part 4; retry 2 when
 * part 4 ends, beside retry 1. No halving would start both retries at once beside 2 or 3 PUTs; a halving per 429
 * would leave 1 slot and start each retry alone.
 */
test("two 429s in one window halve the automatic pool once: the retries wait for a slot and run two at a time", async () => {
  chaos.proxy.set([
    { match: { kind: "presigned", part: 1 }, fault: busy },
    { match: { kind: "presigned", part: 2 }, fault: busy },
    { match: { kind: "presigned", part: 3 }, fault: { kind: "throttle", bytesPerSecond: 8 * MiB } },
    { match: { kind: "presigned", nth: "every" }, fault: { kind: "throttle", bytesPerSecond: 4 * MiB } },
  ]);
  const file = chaosFile(32 * MiB);

  const { data, error } = await chaos.client({ concurrency: "auto" }).upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  await chaos.expectNoUploadsLeft();
  const puts = chaos.proxy.log().filter((entry) => entry.kind === "presigned");
  const first = puts.slice(0, 4);
  expect(first.map((entry) => `${entry.label} ${entry.outcome}`).toSorted()).toEqual([
    "PUT part 1 429",
    "PUT part 2 429",
    "PUT part 3 200",
    "PUT part 4 200",
  ]);
  expect(first.map((entry) => entry.inFlightAtStart).toSorted()).toEqual([0, 1, 2, 3]);
  // Granted lower part first; a retry never waits: Math.random is 0 and the 429 carries no Retry-After.
  expect(puts.slice(4).map((entry) => `${entry.label} ${entry.outcome} beside ${entry.inFlightAtStart}`)).toEqual([
    "PUT part 1 200 beside 1",
    "PUT part 2 200 beside 1",
  ]);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /complete 200"]);
});
