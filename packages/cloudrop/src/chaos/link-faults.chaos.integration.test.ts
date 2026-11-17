// Chaos rows 12 and 17 (design spec §4): a single PUT whose answer is lost after the bucket stored it, and the
// automatic pool under 429s. Parts are 8 MiB except the last (plan audit C2), so row 17 takes four of them. The
// real-time rows 10 and 11 run nightly in stalls.soak.integration.test.ts (M3-K10). Run with `bun run test:chaos`.
import { expect, test } from "vitest";
import { MiB } from "../rules.ts";
import { chaosFile, SINGLE_FILE_SIZE, useChaosFixture } from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

// Row 12, audit C1: the cut comes before the status line, after RustFS stored the object. The client sees the opaque
// outcome and renews the URL through /sign (M3-S10, M3-S11), so the retry's create-only PUT (If-None-Match: *) is
// refused with 412, which the client counts as stored (design spec §5.4).
test("a PUT whose answer is lost after the bucket stored it is sent again, and the bucket's 412 counts as stored", async () => {
  chaos.proxy.set([
    { match: { kind: "presigned", operation: "PutObject" }, fault: { kind: "truncate", at: "beforeHeaders" } },
  ]);
  const file = chaosFile(SINGLE_FILE_SIZE);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  const key = data?.file.key ?? "";
  await chaos.expectStored(key, file);
  expect(await chaos.objectsLeft()).toEqual([key]);
  expect(chaos.bucketRequests()).toEqual(["PUT object reset", "PUT object 412", "HeadObject 200"]);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /complete 200"]);
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
