import { describe, expect, it } from "vitest";
import { crc32cBase64 } from "../checksum.ts";
import { MiB, R2_RULES } from "../rules.ts";
import { presignUrl, signRequest, UNSIGNED_PAYLOAD } from "../storage/sigv4.ts";
import { createFakeR2, type FakeR2 } from "./fake-r2.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
const objectUrl = (key: string) => new URL(`https://account.r2.cloudflarestorage.com/test/${key}`);
const text = (value: string) => new TextEncoder().encode(value);
const signedAt = new Date("2026-11-15T12:00:00Z");

async function presignedPut(
  key: string,
  headers: Record<string, string>,
  options: { secret?: string; date?: Date; expiresIn?: number } = {},
) {
  return presignUrl({
    method: "PUT",
    url: objectUrl(key),
    headers,
    credentials: { ...credentials, secretAccessKey: options.secret ?? credentials.secretAccessKey },
    region: "auto",
    date: options.date ?? signedAt,
    expiresIn: options.expiresIn ?? 60,
  });
}

function fakeAt(secondsAfterSigning = 0): FakeR2 {
  return createFakeR2({
    bucket: "test",
    credentials,
    now: () => new Date(signedAt.getTime() + secondsAfterSigning * 1000),
  });
}

// A header-signed server-side call, the way the storage driver talks to the bucket.
async function call(
  fake: FakeR2,
  method: string,
  pathAndQuery: string,
  options: { body?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = new URL(`https://account.r2.cloudflarestorage.com/test${pathAndQuery}`);
  const headers = await signRequest({
    method,
    url,
    headers: options.headers,
    credentials,
    region: "auto",
    date: signedAt,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  return fake.fetch(url, { method, headers, body: options.body });
}

const code = async (response: Response) => /<Code>(.*?)<\/Code>/.exec(await response.text())?.[1];

async function createUpload(fake: FakeR2, key: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await call(fake, "POST", `/${key}?uploads`, { headers });
  return /<UploadId>(.*?)<\/UploadId>/.exec(await response.text())?.[1] as string;
}

async function uploadPart(fake: FakeR2, key: string, uploadId: string, number: number, body: Uint8Array<ArrayBuffer>) {
  const query = new URLSearchParams({ partNumber: String(number), uploadId });
  const response = await call(fake, "PUT", `/${key}?${query}`, { body });
  return response.headers.get("etag") as string;
}

const completeBody = (parts: [number, string][]) =>
  text(
    `<CompleteMultipartUpload>${parts.map(([number, etag]) => `<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`,
  );

const complete = (fake: FakeR2, key: string, uploadId: string, parts: [number, string][], headers = {}) =>
  call(fake, "POST", `/${key}?${new URLSearchParams({ uploadId })}`, { body: completeBody(parts), headers });

const minPart = R2_RULES.minPartSize;

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

describe("fake R2 single-object rules", () => {
  it("rejects a wrong signed CRC32C with BadDigest and stores nothing", async () => {
    const fake = fakeAt();
    const wrong = await presignedPut("g.txt", { "x-amz-checksum-crc32c": crc32cBase64(text("other")) });
    const rejected = await fake.fetch(wrong, {
      method: "PUT",
      body: text("hi"),
      headers: { "x-amz-checksum-crc32c": crc32cBase64(text("other")) },
    });
    expect(rejected.status).toBe(400);
    expect(await code(rejected)).toBe("BadDigest");
    expect((await call(fake, "HEAD", "/g.txt")).status).toBe(404);
    const right = crc32cBase64(text("hi"));
    const accepted = await fake.fetch(await presignedPut("g.txt", { "x-amz-checksum-crc32c": right }), {
      method: "PUT",
      body: text("hi"),
      headers: { "x-amz-checksum-crc32c": right },
    });
    expect(accepted.status).toBe(200);
  });

  it("answers 412 to a second create-only PUT and keeps the first object", async () => {
    const fake = fakeAt();
    const url = await presignedPut("h.txt", { "if-none-match": "*" });
    const put = (body: string) =>
      fake.fetch(url, { method: "PUT", body: text(body), headers: { "if-none-match": "*" } });
    expect((await put("first")).status).toBe(200);
    const second = await put("second!");
    expect(second.status).toBe(412);
    expect(await code(second)).toBe("PreconditionFailed");
    expect(await (await call(fake, "GET", "/h.txt")).text()).toBe("first");
  });

  it("serves ranges and answers 416 when the range starts past the end", async () => {
    const fake = fakeAt();
    await fake.fetch(await presignedPut("r.txt", {}), { method: "PUT", body: text("0123456789") });
    const part = await call(fake, "GET", "/r.txt", { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    const beyond = await call(fake, "GET", "/r.txt", { headers: { range: "bytes=10-20" } });
    expect(beyond.status).toBe(416);
    expect(await code(beyond)).toBe("InvalidRange");
  });
});

describe("fake R2 multipart rules", () => {
  it("checks part sizes only at completion and lets the upload be repaired", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "m.bin");
    const first = await uploadPart(fake, "m.bin", uploadId, 1, new Uint8Array(minPart).fill(1));
    const tooBig = await uploadPart(fake, "m.bin", uploadId, 2, new Uint8Array(minPart + MiB).fill(2));
    const refused = await complete(fake, "m.bin", uploadId, [
      [1, first],
      [2, tooBig],
    ]);
    expect(refused.status).toBe(400);
    expect(await code(refused)).toBe("InvalidPart");
    expect(fake.pendingUploads()).toBe(1);

    const repaired = await uploadPart(fake, "m.bin", uploadId, 2, new Uint8Array(MiB).fill(3));
    const done = await complete(fake, "m.bin", uploadId, [
      [1, first],
      [2, repaired],
    ]);
    expect(done.status).toBe(200);
    expect(await done.text()).toMatch(/<ETag>"[0-9a-f]{32}-2"<\/ETag>/);
    expect(fake.pendingUploads()).toBe(0);
    const head = await call(fake, "HEAD", "/m.bin");
    expect(head.headers.get("content-length")).toBe(String(minPart + MiB));
    expect(head.headers.get("x-amz-mp-parts-count")).toBe("2");
  });

  it("rejects a non-last part below the minimum with EntityTooSmall", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "s.bin");
    const small = await uploadPart(fake, "s.bin", uploadId, 1, new Uint8Array(MiB));
    const big = await uploadPart(fake, "s.bin", uploadId, 2, new Uint8Array(minPart));
    const refused = await complete(fake, "s.bin", uploadId, [
      [1, small],
      [2, big],
    ]);
    expect(refused.status).toBe(400);
    expect(await code(refused)).toBe("EntityTooSmall");
    expect(fake.pendingUploads()).toBe(1);
  });

  it("rejects an unequal middle part", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "u.bin");
    const a = await uploadPart(fake, "u.bin", uploadId, 1, new Uint8Array(minPart).fill(1));
    const b = await uploadPart(fake, "u.bin", uploadId, 2, new Uint8Array(minPart + 1).fill(2));
    const c = await uploadPart(fake, "u.bin", uploadId, 3, new Uint8Array(1).fill(3));
    const refused = await complete(fake, "u.bin", uploadId, [
      [1, a],
      [2, b],
      [3, c],
    ]);
    expect(await code(refused)).toBe("InvalidPart");
  });

  it("discards the upload on a 412 at completion, then answers NoSuchUpload to a retry", async () => {
    const fake = fakeAt();
    await fake.fetch(await presignedPut("taken.bin", {}), { method: "PUT", body: text("old") });
    const uploadId = await createUpload(fake, "taken.bin");
    const etag = await uploadPart(fake, "taken.bin", uploadId, 1, text("new"));
    const conditional = await complete(fake, "taken.bin", uploadId, [[1, etag]], { "if-none-match": "*" });
    expect(conditional.status).toBe(412);
    expect(fake.pendingUploads()).toBe(0);
    const retry = await complete(fake, "taken.bin", uploadId, [[1, etag]]);
    expect(retry.status).toBe(404);
    expect(await code(retry)).toBe("NoSuchUpload");
    expect(await (await call(fake, "GET", "/taken.bin")).text()).toBe("old");
  });

  it("rejects a wrong part CRC32C at UploadPart with BadDigest", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "k.bin");
    const query = new URLSearchParams({ partNumber: "1", uploadId });
    const response = await call(fake, "PUT", `/k.bin?${query}`, {
      body: text("part"),
      headers: { "x-amz-checksum-crc32c": crc32cBase64(text("nope")) },
    });
    expect(response.status).toBe(400);
    expect(await code(response)).toBe("BadDigest");
  });

  it("paginates ListParts with the NextPartNumberMarker", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "l.bin");
    for (const number of [1, 2, 3]) await uploadPart(fake, "l.bin", uploadId, number, text(`part ${number}`));
    const list = async (extra: Record<string, string>) =>
      (await call(fake, "GET", `/l.bin?${new URLSearchParams({ uploadId, "max-parts": "2", ...extra })}`)).text();
    const first = await list({});
    expect(first).toContain("<IsTruncated>true</IsTruncated>");
    expect(first).toContain("<NextPartNumberMarker>2</NextPartNumberMarker>");
    expect(first.match(/<PartNumber>/g)).toHaveLength(2);
    const second = await list({ "part-number-marker": "2" });
    expect(second).toContain("<IsTruncated>false</IsTruncated>");
    expect(second.match(/<PartNumber>(\d+)<\/PartNumber>/)?.[1]).toBe("3");
  });

  it("aborts with 204, even after the upload completed", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "z.bin");
    const etag = await uploadPart(fake, "z.bin", uploadId, 1, text("x"));
    await complete(fake, "z.bin", uploadId, [[1, etag]]);
    const abort = await call(fake, "DELETE", `/z.bin?${new URLSearchParams({ uploadId })}`);
    expect(abort.status).toBe(204);
  });
});

describe("fake R2 copy", () => {
  it("rewrites a multipart ETag to a plain one and keeps metadata by default", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "src.bin", { "content-type": "video/mp4", "x-amz-meta-id": "abc" });
    const etag = await uploadPart(fake, "src.bin", uploadId, 1, text("content"));
    await complete(fake, "src.bin", uploadId, [[1, etag]]);
    const source = await call(fake, "HEAD", "/src.bin");
    expect(source.headers.get("etag")).toMatch(/-1"$/);

    const copied = await call(fake, "PUT", "/dst.bin", { headers: { "x-amz-copy-source": "/test/src.bin" } });
    expect(copied.status).toBe(200);
    const head = await call(fake, "HEAD", "/dst.bin");
    expect(head.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(head.headers.get("x-amz-mp-parts-count")).toBeNull();
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("x-amz-meta-id")).toBe("abc");
  });

  it("drops what a REPLACE copy does not resend", async () => {
    const fake = fakeAt();
    await fake.fetch(await presignedPut("o.txt", { "content-type": "text/plain", "x-amz-meta-id": "abc" }), {
      method: "PUT",
      body: text("body"),
      headers: { "content-type": "text/plain", "x-amz-meta-id": "abc" },
    });
    await call(fake, "PUT", "/p.txt", {
      headers: {
        "x-amz-copy-source": "/test/o.txt",
        "x-amz-metadata-directive": "REPLACE",
        "x-amz-meta-verified": "1",
      },
    });
    const head = await call(fake, "HEAD", "/p.txt");
    expect(head.headers.get("x-amz-meta-verified")).toBe("1");
    expect(head.headers.get("x-amz-meta-id")).toBeNull();
    expect(head.headers.get("content-type")).toBeNull();
  });

  it("answers NoSuchKey for a missing source", async () => {
    const response = await call(fakeAt(), "PUT", "/dst", { headers: { "x-amz-copy-source": "/test/missing" } });
    expect(response.status).toBe(404);
    expect(await code(response)).toBe("NoSuchKey");
  });
});

describe("fake R2 ListObjectsV2", () => {
  it("lists in UTF-8 byte order and paginates with a continuation token", async () => {
    const fake = fakeAt();
    // U+1F600 sorts before U+FF5E in UTF-16 but after it in UTF-8.
    const keys = ["b", "\u{1F600}", "～", "a/1"];
    for (const key of keys)
      await fake.fetch(await presignedPut(encodeURI(key), {}), { method: "PUT", body: text("x") });
    const list = async (extra: Record<string, string>) =>
      (await call(fake, "GET", `?${new URLSearchParams({ "list-type": "2", "max-keys": "3", ...extra })}`)).text();
    const first = await list({});
    expect(Array.from(first.matchAll(/<Key>(.*?)<\/Key>/g), (match) => match[1])).toEqual(["a/1", "b", "～"]);
    const token = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(first)?.[1] as string;
    const second = await list({ "continuation-token": token });
    expect(Array.from(second.matchAll(/<Key>(.*?)<\/Key>/g), (match) => match[1])).toEqual(["\u{1F600}"]);
    expect(second).toContain("<IsTruncated>false</IsTruncated>");
  });
});
