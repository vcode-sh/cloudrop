// Chaos rows 10 and 11 (design spec §4) in real time: a PUT the bucket never answers, and a part still moving after
// 30 s. Each waits out about 31 s of the fetch transport's allowance, so they run nightly with the soak, not on every
// pull request (M3-K10). `client/transport.test.ts` ("gives a fetch PUT 30 s plus its size at 100 KiB/s") pins the
// allowance exactly with fake timers; these rows prove it end to end through real undici, the proxy and RustFS.
// Run with `bun run test:chaos:soak`.
import { expect, test } from "vitest";
import { MiB } from "../rules.ts";
import { chaosFile, useChaosFixture } from "../testing/chaos-fixture.ts";

const chaos = useChaosFixture();

const KiB = 1024;

/**
 * Row 10: 64 KiB, so a fetch PUT's allowance is 30 000 ms + 65 536 B at 102.4 B/ms = 30 640 ms (M3-U27): the size's
 * share (640 ms) is wide enough to tell from a bare 30 s, and the row stays near 31 s (plan audit C2).
 */
test("a PUT the bucket never answers is given up after 30 s plus its size at 100 KiB/s, renewed and sent again", async () => {
  chaos.proxy.set([{ match: { kind: "presigned", operation: "PutObject" }, fault: { kind: "blackhole" } }]);
  const file = chaosFile(64 * KiB);

  const { data, error } = await chaos.client().upload("files", file);

  expect(error).toBeNull();
  await chaos.expectStored(data?.file.key ?? "", file);
  // "aborted": the client closed the connection; a black hole never forwards, so RustFS saw the second PUT only.
  expect(chaos.bucketRequests()).toEqual(["PUT object aborted", "PUT object 200", "HeadObject 200"]);
  expect(chaos.appRequests()).toEqual(["POST /upload 200", "POST /sign 200", "POST /complete 200"]);
  const [stalled] = chaos.proxy.log();
  const heldMs = (stalled?.endMs ?? 0) - (stalled?.startMs ?? 0);
  // 30 640 ms − 140: the client's timer starts a few ms before the request reaches the proxy, and a bare 30 s timer,
  // even a late one, stays below. 30 640 ms + 560: timer lateness under load, and the close reaching the proxy.
  expect(heldMs).toBeGreaterThan(30_500);
  expect(heldMs).toBeLessThan(31_200);
});

/**
 * Row 11: parts of 8 and 1 MiB. Part 2 at 32 KiB/s takes 32 s, which is longer than the bare 30 s stall and inside
 * its allowance (30 000 ms + 1 MiB at 102.4 B/ms = 40 240 ms, M3-U27), so the row fails if the allowance loses its
 * size share. The design's 64 KiB/s would take 16 s and pass even with a flat 30 s. The XHR half of the row (progress
 * keeps the watchdog alive) is the browser lane's.
 */
test("a part still moving after 30 s, inside 30 s plus its size at 100 KiB/s, is not cut, and is sent once", async () => {
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
