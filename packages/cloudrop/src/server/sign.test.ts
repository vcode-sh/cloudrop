import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignedPart, SignedRequest } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { SECRET, serverFixture } from "../testing/server-fixture.ts";
import { allowAnyone, route } from "./route.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const files = route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone });
// 3 parts of the 8 MiB plan: 8 MiB, 8 MiB and 5 bytes.
const BIG = { name: "big.bin", size: 16 * MiB + 5, type: "application/octet-stream" };
const SMALL = { name: "a.txt", size: 5, type: "text/plain" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function sign(fixture: ReturnType<typeof serverFixture>, body: unknown) {
  const response = await fixture.post("sign", body);
  return {
    status: response.status,
    body: (await response.json()) as {
      parts?: SignedPart[];
      put?: SignedRequest;
      error?: { code: string; message: string };
    },
  };
}

describe("POST /sign: multipart", () => {
  it("signs the requested parts at their planned sizes, which the bucket then accepts", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    const { body } = await sign(fixture, { token: ticket.token, parts: [3, 1] });
    const [last, first] = body.parts ?? [];
    expect([last?.partNumber, first?.partNumber]).toEqual([3, 1]);
    // The last part is signed for 5 bytes, the first for a full 8 MiB: R2 enforces the signed length.
    expect((await fixture.send(last as SignedPart, new Uint8Array(5))).status).toBe(200);
    expect((await fixture.send(last as SignedPart, new Uint8Array(6))).status).toBe(403);
    expect((await fixture.send(first as SignedPart, new Uint8Array(8 * MiB))).status).toBe(200);
  });

  it("takes the key from the token, whatever else the body says", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    const { body } = await sign(fixture, {
      token: ticket.token,
      parts: [1],
      key: "victim/file.bin",
      uploadId: "other",
    });
    const url = new URL(body.parts?.[0]?.url ?? "");
    expect({ path: url.pathname, uploadId: url.searchParams.get("uploadId") }).toEqual({
      path: `/uploads/${ticket.key}`,
      uploadId: "fake/upload+1==",
    });
  });

  it("never signs a URL that outlives its token", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    // One minute before the token's 24 hours end, a 15-minute URL would outlive it by 14 minutes.
    vi.setSystemTime(new Date("2026-11-16T11:59:00Z"));
    const { body } = await sign(fixture, { token: ticket.token, parts: [1] });
    expect(body.parts?.[0]?.expiresAt).toBe("2026-11-16T12:00:00.000Z");
  });

  const rule = "Ask for 1 to 20 different part numbers, each from 1 to 3.";
  it.for<{ name: string; parts: unknown }>([
    { name: "no parts", parts: undefined },
    { name: "an empty list", parts: [] },
    { name: "part 0", parts: [0] },
    { name: "a part past the plan", parts: [4] },
    { name: "a repeated part", parts: [1, 1] },
    { name: "a fractional part", parts: [1.5] },
    { name: "a part as text", parts: ["1"] },
    { name: "parts as a number", parts: 1 },
  ])("refuses $name", async ({ parts }) => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", BIG);
    expect((await sign(fixture, { token: ticket.token, parts })).body.error).toEqual({
      code: "INVALID_INPUT",
      message: rule,
      retryable: false,
    });
  });

  it("signs 20 parts in one call and refuses 21", async () => {
    const fixture = serverFixture({ files }, { multipartThreshold: 0 });
    const ticket = await fixture.multipart("files", { ...BIG, size: 21 * 8 * MiB });
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    const ok = await sign(fixture, { token: ticket.token, parts: twenty });
    const tooMany = await sign(fixture, { token: ticket.token, parts: [...twenty, 21] });
    expect([ok.body.parts?.length, tooMany.body.error?.code]).toEqual([20, "INVALID_INPUT"]);
  });
});

describe("POST /sign: single PUT", () => {
  it("renews the URL with the same signed headers", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", SMALL);
    vi.setSystemTime(new Date("2026-11-15T12:20:00Z"));
    const { body } = await sign(fixture, { token: ticket.token });
    expect({ headers: body.put?.headers, expiresAt: body.put?.expiresAt }).toEqual({
      headers: ticket.put.headers,
      expiresAt: "2026-11-15T12:35:00.000Z",
    });
    expect((await fixture.send(body.put as SignedRequest, new TextEncoder().encode("hello"))).status).toBe(200);
  });

  it("refuses part numbers for a single PUT", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", SMALL);
    expect((await sign(fixture, { token: ticket.token, parts: [1] })).body.error).toEqual({
      code: "INVALID_INPUT",
      message: "This upload is a single PUT: send { token } without parts.",
      retryable: false,
    });
  });
});

describe("POST /sign: tokens", () => {
  it("answers an expired token with 410 UPLOAD_EXPIRED", async () => {
    const fixture = serverFixture({ files });
    const ticket = await fixture.single("files", SMALL);
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const response = await fixture.post("sign", { token: ticket.token });
    expect({
      status: response.status,
      code: ((await response.json()) as { error: { code: string } }).error.code,
    }).toEqual({
      status: 410,
      code: "UPLOAD_EXPIRED",
    });
  });

  it("refuses a token signed with a secret this server does not hold", async () => {
    const ticket = await serverFixture({ files }, { secret: "another-secret-0123456789abcdef0123456" }).single(
      "files",
      SMALL,
    );
    const response = await serverFixture({ files }).post("sign", { token: ticket.token });
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([
      400,
      "INVALID_TOKEN",
    ]);
  });

  it.for<{ name: string; body: unknown; code: string }>([
    { name: "no token", body: {}, code: "INVALID_TOKEN" },
    { name: "a numeric token", body: { token: 5 }, code: "INVALID_TOKEN" },
    { name: "a body that is a string", body: "token", code: "INVALID_INPUT" },
    { name: "a body that is null", body: null, code: "INVALID_INPUT" },
    { name: "a body that is a list", body: [{ token: "x" }], code: "INVALID_INPUT" },
  ])("answers $name with 400 $code", async ({ body, code }) => {
    const response = await serverFixture({ files }).post("sign", body);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([400, code]);
  });

  it("accepts a token signed with the previous secret after a rotation", async () => {
    const before = serverFixture({ files });
    const ticket = await before.single("files", SMALL);
    const after = serverFixture({ files }, { secret: ["rotated-secret-0123456789abcdef0123456", SECRET] });
    expect((await after.post("sign", { token: ticket.token })).status).toBe(200);
  });

  it("refuses a token whose route was removed", async () => {
    const ticket = await serverFixture({ files }).single("files", SMALL);
    const redeployed = serverFixture({ other: files });
    expect(
      ((await (await redeployed.post("sign", { token: ticket.token })).json()) as { error: unknown }).error,
    ).toEqual({
      code: "UNKNOWN_ROUTE",
      message: "The upload route of this token no longer exists. Start a new upload.",
      retryable: false,
    });
  });
});
