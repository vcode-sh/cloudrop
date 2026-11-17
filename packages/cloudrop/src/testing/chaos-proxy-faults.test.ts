import { describe, expect, it, onTestFinished } from "vitest";
import { type ChaosRule, startChaosProxy } from "./chaos-proxy.ts";
import { bytes, client, eventually, startTarget } from "./chaos-proxy-target.ts";

// A presigned part URL as s3() builds one; only the signature parameter's presence matters to the proxy.
const PART_2 = "/bucket/live/file.bin?partNumber=2&uploadId=u-1&X-Amz-Expires=900&X-Amz-Signature=5ec7e7";
const RESET_SEEN = "ECONNRESET: read ECONNRESET";
// What a Node client reports when the connection ends without an answer (FIN, not RST).
const HANG_UP_SEEN = "ECONNRESET: socket hang up";

async function setup(rules: readonly ChaosRule[]) {
  const target = await startTarget();
  const proxy = await startChaosProxy(target.url);
  onTestFinished(() => proxy.stop());
  proxy.set(rules);
  return { target, proxy, send: client(), part2: `${proxy.url}${PART_2}` };
}

const onPart2 = (fault: ChaosRule["fault"]): ChaosRule[] => [{ match: { kind: "presigned", part: 2 }, fault }];

describe("chaos proxy faults", () => {
  it("resets after the given body bytes: the target gets exactly those, the client a reset", async () => {
    const { target, proxy, send, part2 } = await setup(onPart2({ kind: "reset", afterBytes: 100_000 }));
    const seen = await send(part2, { body: bytes(262_144) });
    expect(seen.error).toBe(RESET_SEEN);
    await eventually(() => expect(target.arrivals[0]?.abandoned).toBe(true));
    expect(target.arrivals.map((a) => ({ received: a.body.length, complete: a.complete }))).toEqual([
      { received: 100_000, complete: false },
    ]);
    expect(proxy.log()).toMatchObject([{ label: "PUT part 2", fault: "reset", outcome: "reset" }]);
  });

  it("resets at once with afterBytes 0, before anything reaches the target", async () => {
    const { target, send, part2 } = await setup(onPart2({ kind: "reset", afterBytes: 0 }));
    expect((await send(part2, { body: bytes(1000) })).error).toBe(RESET_SEEN);
    expect(target.arrivals).toEqual([]);
  });

  it("resets a request without a body when it ends, and the target never gets it (ListParts in /complete)", async () => {
    const { target, proxy, send } = await setup([
      { match: { kind: "server", operation: "ListParts" }, fault: { kind: "reset", afterBytes: 1000 } },
    ]);
    const seen = await send(`${proxy.url}/bucket/k?uploadId=u-1`, { method: "GET" });
    expect(seen).toMatchObject({ status: null, error: RESET_SEEN });
    expect(target.arrivals).toEqual([]);
    expect(proxy.log()).toMatchObject([{ label: "ListParts", fault: "reset", outcome: "reset", bytesIn: 0 }]);
  });

  it("resets after the whole body when the body is shorter: stored, but the client loses the answer", async () => {
    const { target, send, part2 } = await setup(onPart2({ kind: "reset", afterBytes: 5000 }));
    expect((await send(part2, { body: bytes(1000) })).error).toBe(RESET_SEEN);
    await eventually(() => expect(target.arrivals[0]?.complete).toBe(true));
    expect(target.arrivals[0]?.body).toEqual(bytes(1000));
  });

  it("closes without answering after reading the body, and forwards nothing", async () => {
    const { target, proxy, send, part2 } = await setup(onPart2({ kind: "close" }));
    expect((await send(part2, { body: bytes(5000) })).error).toBe(HANG_UP_SEEN);
    expect(target.arrivals).toEqual([]);
    expect(proxy.log()).toMatchObject([{ fault: "close", outcome: "closed", bytesIn: 5000 }]);
  });

  it("holds a black-holed request until release(), then resets it", async () => {
    const { target, proxy, send, part2 } = await setup(onPart2({ kind: "blackhole" }));
    let answered = false;
    const pending = send(part2, { body: bytes(5000) }).finally(() => {
      answered = true;
    });
    await eventually(() => expect(proxy.log()).toMatchObject([{ outcome: "held", bytesIn: 5000, endMs: null }]));
    expect(answered).toBe(false);
    proxy.release();
    expect((await pending).error).toBe(RESET_SEEN);
    expect(proxy.log()).toMatchObject([{ fault: "blackhole", outcome: "reset", endMs: expect.any(Number) }]);
    expect(target.arrivals).toEqual([]);
  });

  it("resets a black-holed request when the proxy stops", async () => {
    const { proxy, send, part2 } = await setup(onPart2({ kind: "blackhole" }));
    const pending = send(part2, { body: "x" });
    await eventually(() => expect(proxy.log()).toMatchObject([{ outcome: "held" }]));
    await proxy.stop();
    expect((await pending).error).toBe(RESET_SEEN);
  });

  it("logs a black-holed request as aborted, with its end time, when the client gives up", async () => {
    const { proxy, send, part2 } = await setup(onPart2({ kind: "blackhole" }));
    const giveUp = new AbortController();
    const pending = send(part2, { body: "x", signal: giveUp.signal });
    await eventually(() => expect(proxy.log()).toMatchObject([{ outcome: "held" }]));
    giveUp.abort();
    expect((await pending).error).toBe("ABORT_ERR: The operation was aborted");
    await eventually(() => expect(proxy.log()).toMatchObject([{ outcome: "aborted", endMs: expect.any(Number) }]));
    proxy.release();
    expect(proxy.log()).toMatchObject([{ fault: "blackhole", outcome: "aborted" }]);
  });

  // libuv's timers run on a millisecond clock, so one can fire up to 1 ms early by performance.now().
  const TIMER_SLACK_MS = 1;

  it("delays before forwarding: the target sees the request only after the delay", async () => {
    const { target, send, part2 } = await setup(onPart2({ kind: "delay", ms: 30, when: "before" }));
    const sentAt = performance.now();
    const seen = await send(part2, { body: "x" });
    expect(seen).toMatchObject({ status: 200, body: "received 1" });
    expect(seen.elapsedMs).toBeGreaterThanOrEqual(30 - TIMER_SLACK_MS);
    expect((target.arrivals[0]?.atMs ?? 0) - sentAt).toBeGreaterThanOrEqual(30 - TIMER_SLACK_MS);
  });

  it("delays after forwarding: the target sees the request at once, the client its answer after the delay", async () => {
    const { target, send, part2 } = await setup(onPart2({ kind: "delay", ms: 40, when: "after" }));
    const sentAt = performance.now();
    const seen = await send(part2, { body: "x" });
    expect(seen).toMatchObject({ status: 200, body: "received 1" });
    expect(seen.elapsedMs).toBeGreaterThanOrEqual(40 - TIMER_SLACK_MS);
    expect((target.arrivals[0]?.atMs ?? Infinity) - sentAt).toBeLessThan(40);
  });

  // ~100 ms by design: two slices of a twentieth of a second's worth each, the smallest run that shows pacing.
  it("throttles the body to the given rate and still delivers every byte", async () => {
    const { target, send, part2 } = await setup(onPart2({ kind: "throttle", bytesPerSecond: 20_000 }));
    const seen = await send(part2, { body: bytes(2000) });
    expect(seen.status).toBe(200);
    expect(seen.elapsedMs).toBeGreaterThanOrEqual(2000 / 20 - TIMER_SLACK_MS);
    expect(target.arrivals[0]?.body).toEqual(bytes(2000));
  });

  const SLOW_DOWN = "<Error><Code>SlowDown</Code></Error>";
  const LAB = "http://localhost:5173";
  it.each([
    { name: "with CORS by default", cors: undefined, expose: undefined, origin: LAB, allow: LAB, exposed: undefined },
    { name: "without CORS when told", cors: false, expose: true, origin: LAB, allow: undefined, exposed: undefined },
    { name: "exposing Retry-After", cors: undefined, expose: true, origin: LAB, allow: LAB, exposed: "Retry-After" },
    {
      name: "without CORS for no Origin",
      cors: true,
      expose: true,
      origin: undefined,
      allow: undefined,
      exposed: undefined,
    },
  ])("answers in the target's place $name", async ({ cors, expose, origin, allow, exposed }) => {
    const headers = { "retry-after": "2" };
    const { target, proxy, send, part2 } = await setup(
      onPart2({ kind: "answer", status: 429, body: SLOW_DOWN, headers, cors, exposeRetryAfter: expose }),
    );
    const seen = await send(part2, { body: bytes(3000), headers: origin === undefined ? {} : { origin } });
    expect(seen).toMatchObject({ status: 429, body: SLOW_DOWN, error: null });
    expect(seen.headers).toMatchObject({ "retry-after": "2" });
    expect(seen.headers["access-control-allow-origin"]).toBe(allow);
    expect(seen.headers["access-control-expose-headers"]).toBe(exposed);
    expect(target.arrivals).toEqual([]);
    expect(proxy.log()).toMatchObject([{ fault: "answer", outcome: 429, bytesIn: 3000 }]);
  });

  it("cuts before the headers once the target has answered in full: stored, but no status reaches the client", async () => {
    const { target, proxy, send } = await setup(onPart2({ kind: "truncate", at: "beforeHeaders" }));
    // The target's answer takes 10 ms, so a proxy that reset the client sooner would find it still answering.
    const seen = await send(`${proxy.url}/drip${PART_2}`, { body: bytes(2000) });
    expect(seen).toMatchObject({ status: null, error: RESET_SEEN });
    const [arrival] = target.arrivals;
    expect(arrival?.body).toEqual(bytes(2000));
    expect({ complete: arrival?.complete, answered: arrival?.answered }).toEqual({ complete: true, answered: true });
    expect(proxy.log()).toMatchObject([{ label: "PUT part 2", fault: "truncate", outcome: "reset" }]);
  });

  it("cuts inside the body: the status and headers arrive, the body does not, the target got it all", async () => {
    const { target, proxy, send, part2 } = await setup(onPart2({ kind: "truncate", at: "inBody" }));
    const seen = await send(part2, { body: bytes(2000) });
    expect(seen).toMatchObject({ status: 200, body: "", error: "ECONNRESET: aborted" });
    expect(seen.headers.etag).toBe('"etag-1"');
    expect(target.arrivals.map((a) => ({ received: a.body.length, complete: a.complete }))).toEqual([
      { received: 2000, complete: true },
    ]);
    expect(proxy.log()).toMatchObject([{ fault: "truncate", outcome: 200 }]);
  });

  it("strips the target's CORS headers from a faulted answer and keeps the rest", async () => {
    const { send, part2 } = await setup([{ match: { part: 2, nth: 2 }, fault: { kind: "stripCors" } }]);
    const forwarded = await send(part2, { body: "x" });
    const stripped = await send(part2, { body: "x" });
    expect(forwarded.headers).toMatchObject({ "access-control-allow-origin": "*", etag: '"etag-1"' });
    expect(stripped).toMatchObject({ status: 200, body: "received 1" });
    expect(stripped.headers.etag).toBe('"etag-1"');
    expect(Object.keys(stripped.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
  });
});
