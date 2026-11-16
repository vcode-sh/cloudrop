import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../storage/sigv4.ts";
import { call, code, fakeAt, objectUrl, presignedPut, signed, signedAt, text } from "./fixture.ts";

describe("fake R2 signature checks", () => {
  it("accepts a body that matches the signed length and rejects other lengths", async () => {
    const fake = fakeAt();
    const url = await presignedPut("a.txt", { "content-length": "5" });
    expect((await fake.fetch(url, { method: "PUT", body: text("hello") })).status).toBe(200);
    const wrong = await fake.fetch(url, { method: "PUT", body: text("hello!") });
    expect(wrong.status).toBe(403);
    expect(await code(wrong)).toBe("SignatureDoesNotMatch");
  });

  it("rejects an omitted signed header", async () => {
    const fake = fakeAt();
    const url = await presignedPut("b.txt", { "content-length": "2", "if-none-match": "*" });
    const omitted = await fake.fetch(url, { method: "PUT", body: text("hi") });
    expect(omitted.status).toBe(403);
    expect(await code(omitted)).toBe("SignatureDoesNotMatch");
    const sent = await fake.fetch(url, { method: "PUT", body: text("hi"), headers: { "if-none-match": "*" } });
    expect(sent.status).toBe(200);
  });

  it("rejects a signed content-type that the request does not send", async () => {
    const fake = fakeAt();
    const url = await presignedPut("t.txt", { "content-type": "image/png" });
    const response = await fake.fetch(url, {
      method: "PUT",
      body: text("hi"),
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("SignatureDoesNotMatch");
  });

  it("rejects URLs signed with another secret", async () => {
    const forged = await presignedPut("c.txt", { "content-length": "2" }, { secret: "another-secret" });
    const response = await fakeAt().fetch(forged, { method: "PUT", body: text("hi") });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("SignatureDoesNotMatch");
  });

  it("rejects unsigned requests", async () => {
    const response = await fakeAt().fetch(objectUrl("d.txt"), { method: "PUT", body: text("hi") });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("AccessDenied");
  });
});

describe("fake R2 header-signed requests", () => {
  it("rejects a signature made with another secret", async () => {
    const response = await call(fakeAt(), "PUT", "/hs.txt", { body: text("hi"), secret: "another-secret" });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("SignatureDoesNotMatch");
  });

  it("rejects a request whose query differs from the signed one", async () => {
    const { headers } = await signed("PUT", "/hs.txt?x=1", { body: text("hi") });
    const response = await fakeAt().fetch(objectUrl("hs.txt?x=2"), { method: "PUT", headers, body: text("hi") });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("SignatureDoesNotMatch");
  });

  it("rejects a signed header that the request does not send", async () => {
    const { url, headers } = await signed("PUT", "/hs.txt", { body: text("hi"), headers: { "x-amz-meta-id": "a" } });
    const { "x-amz-meta-id": _dropped, ...sent } = headers;
    const response = await fakeAt().fetch(url, { method: "PUT", headers: sent, body: text("hi") });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("SignatureDoesNotMatch");
  });

  it("checks a signed payload hash against the body", async () => {
    const fake = fakeAt();
    const other = await call(fake, "PUT", "/hs.txt", { body: text("hi"), payloadHash: await sha256Hex(text("other")) });
    expect(other.status).toBe(400);
    expect(await code(other)).toBe("XAmzContentSHA256Mismatch");
    const right = await call(fake, "PUT", "/hs.txt", { body: text("hi"), payloadHash: await sha256Hex(text("hi")) });
    expect(right.status).toBe(200);
  });

  it("rejects a request dated more than 15 minutes from the clock, in either direction", async () => {
    const stale = await call(fakeAt(2 * 3600), "PUT", "/hs.txt", { body: text("hi") });
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("RequestTimeTooSkewed");
    const early = await call(fakeAt(-2 * 3600), "PUT", "/hs.txt", { body: text("hi") });
    expect(early.status).toBe(403);
    expect(await code(early)).toBe("RequestTimeTooSkewed");
    expect((await call(fakeAt(14 * 60), "PUT", "/hs.txt", { body: text("hi") })).status).toBe(200);
  });

  it("verifies the query as written, so an encoding-only difference fails", async () => {
    const fake = fakeAt();
    const url = await presignedPut("q.txt?x=a%20b", {});
    expect((await fake.fetch(url, { method: "PUT", body: text("hi") })).status).toBe(200);
    const plus = new URL(url.href.replace("x=a%20b", "x=a+b"));
    const response = await fake.fetch(plus, { method: "PUT", body: text("hi") });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("SignatureDoesNotMatch");
    const { headers } = await signed("PUT", "/q.txt?x=a%20b", { body: text("hi") });
    const plusHeader = await fake.fetch(objectUrl("q.txt?x=a+b"), { method: "PUT", headers, body: text("hi") });
    expect(await code(plusHeader)).toBe("SignatureDoesNotMatch");
  });
});

describe("fake R2 presigned expiry", () => {
  it("rejects a URL one second after it expires and accepts it one second before", async () => {
    const url = await presignedPut("c.txt", { "content-length": "2" });
    expect((await fakeAt(59).fetch(url, { method: "PUT", body: text("hi") })).status).toBe(200);
    const expired = await fakeAt(61).fetch(url, { method: "PUT", body: text("hi") });
    expect(expired.status).toBe(403);
    expect(await code(expired)).toBe("ExpiredRequest");
  });

  it("rejects an expiry beyond seven days with InvalidArgument and accepts exactly seven days", async () => {
    const tooLong = await presignedPut("e.txt", {}, { expiresIn: 604_801 });
    const rejected = await fakeAt().fetch(tooLong, { method: "PUT", body: text("hi") });
    expect(rejected.status).toBe(400);
    expect(await code(rejected)).toBe("InvalidArgument");
    const week = await presignedPut("e.txt", {}, { expiresIn: 604_800 });
    expect((await fakeAt().fetch(week, { method: "PUT", body: text("hi") })).status).toBe(200);
  });

  it("rejects a URL dated 30 minutes in the future", async () => {
    const future = await presignedPut("f.txt", {}, { date: new Date(signedAt.getTime() + 30 * 60 * 1000) });
    const response = await fakeAt().fetch(future, { method: "PUT", body: text("hi") });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("RequestTimeTooSkewed");
  });
});
