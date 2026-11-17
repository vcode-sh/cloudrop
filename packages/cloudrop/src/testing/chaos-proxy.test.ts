import { createServer } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type ChaosRandom, type ChaosRule, startChaosProxy } from "./chaos-proxy.ts";
import { close, listen } from "./chaos-proxy-control.ts";
import { bytes, client, eventually, type SendOptions, startTarget } from "./chaos-proxy-target.ts";

// What s3() puts in a presigned URL's query and on its own calls; secrets are spelled out so a leak is easy to find.
const SIGNED = "X-Amz-Credential=AKIDSECRET%2F20261117%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=5ec7e7secret";
const AUTHORIZATION = "AWS4-HMAC-SHA256 Credential=AKIDSECRET/20261117/auto/s3/aws4_request, Signature=5ec7e7secret";
const SERVER: SendOptions = { headers: { authorization: AUTHORIZATION, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" } };

async function setup(rules: readonly ChaosRule[] = [], target?: string) {
  const echo = await startTarget();
  const proxy = await startChaosProxy(target ?? echo.url);
  onTestFinished(() => proxy.stop());
  proxy.set(rules);
  const send = client();
  return {
    target: echo,
    proxy,
    send,
    /** A presigned request to `path`, whose own query (if any) comes before the signature. */
    presigned: (path: string, options: SendOptions = {}) =>
      send(`${proxy.url}${path}${path.includes("?") ? "&" : "?"}${SIGNED}`, options),
    server: (path: string, options: SendOptions = {}) =>
      send(`${proxy.url}${path}`, { ...options, headers: { ...SERVER.headers, ...options.headers } }),
  };
}

describe("chaos proxy forwarding", () => {
  it("forwards a request with Host, path, query, headers and body untouched, and the target's answer back", async () => {
    const { target, proxy, presigned } = await setup();
    const body = bytes(204_800);
    const seen = await presigned("/bucket/a%20b/file.bin?partNumber=1&uploadId=u-1", {
      body,
      headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
    });
    expect(seen).toMatchObject({ status: 200, body: "received 204800", error: null });
    expect(seen.headers.etag).toBe('"etag-1"');
    const [arrival] = target.arrivals;
    expect(arrival?.headers).toMatchObject({
      host: new URL(proxy.url).host,
      "content-type": "application/octet-stream",
      "if-none-match": "*",
      "content-length": "204800",
    });
    expect(arrival?.url).toBe(`/bucket/a%20b/file.bin?partNumber=1&uploadId=u-1&${SIGNED}`);
    expect(arrival?.body.equals(body)).toBe(true);
    expect(proxy.log()).toMatchObject([{ label: "PUT part 1", fault: null, outcome: 200, bytesIn: 204_800 }]);
  });

  it.each<{ name: string; headers: Record<string, string> }>([
    { name: "with a length", headers: { "Content-Length": "5" } },
    { name: "chunked", headers: { "Transfer-Encoding": "chunked" } },
  ])("forwards every request header verbatim and adds none, $name", async ({ headers }) => {
    const { target, proxy, send } = await setup();
    const signed = {
      Host: new URL(proxy.url).host,
      "X-Amz-Date": "20261117T000000Z",
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    };
    const options = { headers: { ...signed, ...headers, Authorization: AUTHORIZATION }, body: "hello" };
    // The same request straight to the target is the oracle for what the client put on the wire.
    await send(`${target.url}/b/k`, options);
    await send(`${proxy.url}/b/k`, options);
    const [direct, proxied] = target.arrivals;
    expect(proxied?.rawHeaders).toEqual(direct?.rawHeaders);
    expect(proxied?.body.toString()).toBe("hello");
  });

  it("labels each request by who sent it and which S3 operation it is", async () => {
    const { proxy, send, presigned, server } = await setup();
    await presigned("/b/k?partNumber=2&uploadId=u", { body: "x" });
    await presigned("/b/k", { body: "x" });
    await presigned("/b/k", { method: "GET" });
    await server("/b/k?uploads=", { method: "POST" });
    await server("/b/k?uploadId=u", { method: "POST", body: "<CompleteMultipartUpload/>" });
    await server("/b/k?uploadId=u&max-parts=1000", { method: "GET" });
    await server("/b/k?uploadId=u", { method: "DELETE" });
    await server("/b/k", { method: "HEAD" });
    await server("/b/k", { method: "GET" });
    await server("/b/k", { method: "PUT", body: "x" });
    await server("/b/k", { method: "DELETE" });
    await server("/b?list-type=2&prefix=p", { method: "GET" });
    await server("/b?uploads=&prefix=p", { method: "GET" });
    await server("/b?cors=", { method: "GET" });
    await server("/b/k2", { method: "PUT", headers: { "x-amz-copy-source": "/b/k" } });
    await send(`${proxy.url}/b/k?partNumber=1&uploadId=u`, { method: "OPTIONS" });
    expect(proxy.log().map((entry) => `${entry.kind} ${entry.label}`)).toEqual([
      "presigned PUT part 2",
      "presigned PUT object",
      "presigned GetObject",
      "server CreateMultipartUpload",
      "server CompleteMultipartUpload",
      "server ListParts",
      "server AbortMultipartUpload",
      "server HeadObject",
      "server GetObject",
      "server PutObject",
      "server DeleteObject",
      "server ListObjectsV2",
      "server ListMultipartUploads",
      "server Other GET",
      "server Other PUT",
      "preflight OPTIONS",
    ]);
  });

  it("answers 502 and logs an error when the target cannot be reached", async () => {
    const gone = createServer();
    const url = await listen(gone, 0);
    await close(gone);
    const { proxy, presigned } = await setup([], url);
    expect(await presigned("/b/k", { method: "GET" })).toMatchObject({ status: 502, error: null });
    expect(await presigned("/b/k", { body: bytes(100_000) })).toMatchObject({ status: 502, error: null });
    expect(proxy.log().map((entry) => entry.outcome)).toEqual(["error", "error"]);
  });

  it("hangs up on the target when the client leaves mid-exchange, and logs it as aborted", async () => {
    const { target, proxy, presigned } = await setup();
    const leave = new AbortController();
    const pending = presigned("/hold/k", { method: "GET", signal: leave.signal });
    await eventually(() => expect(target.arrivals).toHaveLength(1));
    leave.abort();
    await pending;
    await eventually(() => expect(target.arrivals[0]?.abandoned).toBe(true));
    expect(proxy.log()).toMatchObject([{ label: "GetObject", outcome: "aborted", endMs: expect.any(Number) }]);
  });
});

describe("chaos proxy rules", () => {
  it("faults only the nth match of a rule: the second PUT of part 2, not the first or third, nor part 1", async () => {
    const answer = { kind: "answer", status: 503 } as const;
    const { target, presigned } = await setup([{ match: { kind: "presigned", part: 2, nth: 2 }, fault: answer }]);
    const statuses = [];
    for (const part of [2, 1, 2, 2]) {
      statuses.push((await presigned(`/b/k?partNumber=${part}&uploadId=u`, { body: "x" })).status);
    }
    expect(statuses).toEqual([200, 200, 503, 200]);
    expect(target.arrivals).toHaveLength(3);
  });

  it("faults every match with nth 'every', and only requests of the rule's kind", async () => {
    const { presigned, server } = await setup([
      { match: { kind: "server", operation: "PutObject", nth: "every" }, fault: { kind: "answer", status: 500 } },
    ]);
    const statuses = [
      (await server("/b/k", { body: "x" })).status,
      (await presigned("/b/k", { body: "x" })).status,
      (await server("/b/k", { body: "x" })).status,
    ];
    expect(statuses).toEqual([500, 200, 500]);
  });

  it("never counts a preflight against a PUT rule, while a rule naming Options faults it", async () => {
    const answer = (status: number) => ({ kind: "answer", status, cors: true }) as const;
    const { target, proxy, send, presigned } = await setup([
      { match: { nth: 1 }, fault: answer(500) },
      { match: { operation: "Options", nth: 2 }, fault: answer(403) },
    ]);
    const options = () => send(`${proxy.url}/b/k?partNumber=1&uploadId=u`, { method: "OPTIONS" });
    expect((await options()).status).toBe(200);
    expect((await presigned("/b/k?partNumber=1&uploadId=u", { body: "x" })).status).toBe(500);
    expect((await options()).status).toBe(403);
    expect(target.arrivals.map((a) => a.method)).toEqual(["OPTIONS"]);
  });

  it("restarts the nth counters when the rules are set again", async () => {
    const rules: ChaosRule[] = [{ match: { part: 1, nth: 2 }, fault: { kind: "answer", status: 503 } }];
    const { proxy, presigned } = await setup(rules);
    const put = async () => (await presigned("/b/k?partNumber=1&uploadId=u", { body: "x" })).status;
    expect(await put()).toBe(200);
    proxy.set(rules);
    expect([await put(), await put()]).toEqual([200, 503]);
  });
});

describe("chaos proxy log and modes", () => {
  it("never logs a query string, a header value or a body", async () => {
    const { proxy, presigned, server } = await setup([{ match: { part: 3 }, fault: { kind: "answer", status: 403 } }]);
    const secretBody = "BODY-SECRET";
    await presigned("/b/k?partNumber=3&uploadId=UPLOAD-SECRET", {
      body: secretBody,
      headers: { "x-custom": "HDR-SECRET" },
    });
    await server("/b/k?uploadId=UPLOAD-SECRET", { method: "POST", body: secretBody });
    const serialized = JSON.stringify(proxy.log());
    expect(serialized).toContain("PUT part 3");
    expect(serialized.match(/\?|x-amz|secret|aws4|content|application/gi)).toBeNull();
  });

  it("counts the presigned PUTs in flight when each request starts", async () => {
    const hold: ChaosRule = { match: { operation: "UploadPart", nth: "every" }, fault: { kind: "blackhole" } };
    const { proxy, presigned, server } = await setup([hold]);
    const held = [presigned("/b/k?partNumber=1&uploadId=u", { body: "x" })];
    await eventually(() => expect(proxy.log()).toHaveLength(1));
    held.push(presigned("/b/k?partNumber=2&uploadId=u", { body: "x" }));
    await eventually(() => expect(proxy.log()).toHaveLength(2));
    await presigned("/b/k", { method: "GET" });
    await server("/b/k", { body: "x" });
    proxy.release();
    await Promise.all(held);
    await presigned("/b/k", { body: "x" });
    expect(proxy.log().map((entry) => [entry.label, entry.inFlightAtStart])).toEqual([
      ["PUT part 1", 0],
      ["PUT part 2", 1],
      ["GetObject", 2],
      ["PutObject", 2],
      ["PUT object", 0],
    ]);
  });

  it("replays the same random faults for the same seed, other ones for another seed, and none when off", async () => {
    // The chaos lanes stub Math.random to 0; the random mode must not depend on it.
    const stub = vi.spyOn(Math, "random").mockReturnValue(0);
    onTestFinished(() => stub.mockRestore());
    const { proxy, presigned, send } = await setup();
    const run = async (options: ChaosRandom | null) => {
      proxy.clearLog();
      proxy.random(options);
      await send(`${proxy.url}/b/k`, { method: "OPTIONS" });
      for (let request = 0; request < 12; request++) await presigned("/b/k", { body: bytes(1000) });
      return proxy.log().map((entry) => `${entry.fault} ${entry.outcome}`);
    };
    const options = (seed: number): ChaosRandom => ({ seed, resetRate: 0.25, busyRate: 0.25, latencyMs: [0, 1] });
    const first = await run(options(7));
    expect(await run(options(7))).toEqual(first);
    expect(await run(options(8))).not.toEqual(first);
    expect(first[0]).toBe("null 200");
    expect(new Set(first.slice(1)).size).toBeGreaterThan(1);
    expect(new Set(await run(null))).toEqual(new Set(["null 200"]));
  });

  it("stops listening on both ports and closes every socket, held and kept-alive ones included", async () => {
    const target = await startTarget();
    const proxy = await startChaosProxy(target.url, { control: true });
    onTestFinished(() => proxy.stop());
    proxy.set([{ match: { part: 9 }, fault: { kind: "blackhole" } }]);
    const send = client();
    expect((await send(`${proxy.url}/b/k`, SERVER)).status).toBe(200);
    expect(target.connections()).toBe(1);
    const pending = send(`${proxy.url}/b/k?partNumber=9&uploadId=u&${SIGNED}`, { body: "x" });
    await eventually(() => expect(proxy.log()).toHaveLength(2));
    await proxy.stop();
    expect((await pending).error).toBe("ECONNRESET: read ECONNRESET");
    expect((await send(`${proxy.url}/b/k`, { method: "GET" })).error).toMatch(/^ECONNREFUSED: /);
    expect((await send(`${proxy.controlUrl}/log`, { method: "GET" })).error).toMatch(/^ECONNREFUSED: /);
    // The proxy's kept-alive connection to the target was its own; the target sees it close.
    await eventually(() => expect(target.connections()).toBe(0));
  });
});

describe("chaos proxy control endpoint", () => {
  it("sets rules, reads and clears the log, and releases held requests over HTTP", async () => {
    const target = await startTarget();
    const proxy = await startChaosProxy(target.url, { control: true });
    onTestFinished(() => proxy.stop());
    const send = client();
    const control = (path: string, body?: unknown) =>
      send(`${proxy.controlUrl}${path}`, { method: body === undefined ? "GET" : "POST", body: JSON.stringify(body) });
    const rules: ChaosRule[] = [{ match: { kind: "server", nth: "every" }, fault: { kind: "blackhole" } }];
    expect((await control("/rules", rules)).status).toBe(204);
    const pending = send(`${proxy.url}/b/k`, { ...SERVER, method: "GET" });
    await eventually(() => expect(proxy.log()).toHaveLength(1));
    expect((await control("/release", null)).status).toBe(204);
    expect((await pending).error).toBe("ECONNRESET: read ECONNRESET");
    const log = await control("/log");
    expect(JSON.parse(log.body)).toEqual(proxy.log());
    expect((await control("/clear-log", null)).status).toBe(204);
    expect(proxy.log()).toEqual([]);
  });

  it.each([
    { name: "rules that are not an array", path: "/rules", body: '{"match":{}}', status: 400 },
    { name: "a body that is not JSON", path: "/random", body: "{", status: 400 },
    { name: "an unknown route", path: "/rule", body: "[]", status: 404 },
  ])("refuses $name and leaves the proxy as it was", async ({ path, body, status }) => {
    const target = await startTarget();
    const proxy = await startChaosProxy(target.url, { control: true });
    onTestFinished(() => proxy.stop());
    const send = client();
    const refused = await send(`${proxy.controlUrl}${path}`, { method: "POST", body });
    expect(refused.status).toBe(status);
    expect(JSON.parse(refused.body)).toEqual({ error: expect.stringMatching(/\.$/) });
    expect((await send(`${proxy.url}/b/k`, { ...SERVER, method: "GET" })).status).toBe(200);
  });
});
