import { describe, expect, it } from "vitest";
import { crc32cBase64 } from "../checksum.ts";
import { MiB, R2_RULES } from "../rules.ts";
import { call, code, fakeAt, presignedPut, text } from "./fake-r2/fixture.ts";
import type { FakeR2 } from "./fake-r2.ts";

async function createUpload(fake: FakeR2, key: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await call(fake, "POST", `/${key}?uploads`, { headers });
  return /<UploadId>(.*?)<\/UploadId>/.exec(await response.text())?.[1] as string;
}

async function uploadPart(fake: FakeR2, key: string, uploadId: string, number: number, body: Uint8Array<ArrayBuffer>) {
  const query = new URLSearchParams({ partNumber: String(number), uploadId });
  const response = await call(fake, "PUT", `/${key}?${query}`, { body });
  expect(response.status, `UploadPart ${number} of ${key}`).toBe(200);
  return response.headers.get("etag") as string;
}

const completeBody = (parts: [number, string][]) =>
  text(
    `<CompleteMultipartUpload>${parts.map(([number, etag]) => `<Part><PartNumber>${number}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`,
  );

const complete = (fake: FakeR2, key: string, uploadId: string, parts: [number, string][], headers = {}) =>
  call(fake, "POST", `/${key}?${new URLSearchParams({ uploadId })}`, { body: completeBody(parts), headers });

const minPart = R2_RULES.minPartSize;

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
    expect((await call(fake, "GET", "/r.txt", { headers: { range: "bytes=5-2" } })).status).toBe(416);
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
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toContain("<Code>InvalidPart</Code>");
    expect(body).toContain("All non-trailing parts must have the same length.");
    expect(fake.pendingUploads()).toBe(1);
  });

  it("refuses a completion whose ETag does not match the uploaded part, and keeps the upload", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "w.bin");
    await uploadPart(fake, "w.bin", uploadId, 1, text("part"));
    const refused = await complete(fake, "w.bin", uploadId, [[1, '"00000000000000000000000000000000"']]);
    expect(refused.status).toBe(400);
    expect(await code(refused)).toBe("InvalidPart");
    expect(fake.pendingUploads()).toBe(1);
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

  it("removes a pending upload on abort, but only through its own key", async () => {
    const fake = fakeAt();
    const uploadId = await createUpload(fake, "a.bin");
    const query = new URLSearchParams({ uploadId });
    const wrongKey = await call(fake, "DELETE", `/other.bin?${query}`);
    expect(wrongKey.status).toBe(204);
    expect(fake.pendingUploads()).toBe(1);
    expect((await call(fake, "DELETE", `/a.bin?${query}`)).status).toBe(204);
    expect(fake.pendingUploads()).toBe(0);
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

  it("copies a byte range into a part and completes with it", async () => {
    const fake = fakeAt();
    await fake.fetch(await presignedPut("big.txt", {}), { method: "PUT", body: text("0123456789") });
    const uploadId = await createUpload(fake, "joined.txt");
    const query = new URLSearchParams({ partNumber: "1", uploadId });
    const copied = await call(fake, "PUT", `/joined.txt?${query}`, {
      headers: { "x-amz-copy-source": "/test/big.txt", "x-amz-copy-source-range": "bytes=2-5" },
    });
    expect(copied.status).toBe(200);
    const etag = /<ETag>(.*?)<\/ETag>/.exec(await copied.text())?.[1] as string;
    await complete(fake, "joined.txt", uploadId, [[1, etag]]);
    expect(await (await call(fake, "GET", "/joined.txt")).text()).toBe("2345");
  });

  it("validates the part number and the byte range of a part copy", async () => {
    const fake = fakeAt();
    await fake.fetch(await presignedPut("src.txt", {}), { method: "PUT", body: text("0123456789") });
    const uploadId = await createUpload(fake, "d.txt");
    const copyPart = (partNumber: string, range: string) =>
      call(fake, "PUT", `/d.txt?${new URLSearchParams({ partNumber, uploadId })}`, {
        headers: { "x-amz-copy-source": "/test/src.txt", "x-amz-copy-source-range": range },
      });
    const answer = async (partNumber: string, range: string) => {
      const response = await copyPart(partNumber, range);
      return [response.status, await code(response)];
    };
    expect({
      "part 0": await answer("0", "bytes=0-3"),
      "a range past the source's end": await answer("1", "bytes=0-10"),
      "a reversed range": await answer("1", "bytes=5-2"),
    }).toEqual({
      "part 0": [400, "InvalidArgument"],
      "a range past the source's end": [400, "InvalidArgument"],
      "a reversed range": [400, "InvalidArgument"],
    });
  });
});

describe("fake R2 ListObjectsV2", () => {
  it("lists in UTF-8 byte order and paginates with a continuation token", async () => {
    const fake = fakeAt();
    // U+1F600 sorts before U+FF5E in UTF-16 but after it in UTF-8.
    const keys = ["b", "\u{1F600}", "～", "a/1"];
    for (const key of keys)
      await fake.fetch(await presignedPut(encodeURI(key), {}), { method: "PUT", body: text("x") });
    const listPage = (extra: Record<string, string>) =>
      call(fake, "GET", `?${new URLSearchParams({ "list-type": "2", "max-keys": "3", ...extra })}`);
    const list = async (extra: Record<string, string>) => (await listPage(extra)).text();
    const first = await list({});
    expect(Array.from(first.matchAll(/<Key>(.*?)<\/Key>/g), (match) => match[1])).toEqual(["a/1", "b", "～"]);
    const token = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(first)?.[1] as string;
    expect(token).not.toBe("～");
    const forged = await listPage({ "continuation-token": "～" });
    expect(forged.status).toBe(400);
    expect(await code(forged)).toBe("InvalidArgument");
    const second = await list({ "continuation-token": token });
    expect(Array.from(second.matchAll(/<Key>(.*?)<\/Key>/g), (match) => match[1])).toEqual(["\u{1F600}"]);
    expect(second).toContain("<IsTruncated>false</IsTruncated>");
  });
});

// Measured on R2 (r2-spike-findings.md, "Keys"): the NFC and NFD forms of a key are one object.
describe("fake R2 keys in two Unicode forms", () => {
  const nfc = "caf\u00e9.txt";
  const nfd = "cafe\u0301.txt";
  const put = (fake: FakeR2, key: string, body: string, headers = {}) =>
    call(fake, "PUT", `/${encodeURIComponent(key)}`, { body: text(body), headers });
  const listed = async (fake: FakeR2, prefix: string) => {
    const response = await call(fake, "GET", `?${new URLSearchParams({ "list-type": "2", prefix })}`);
    return Array.from((await response.text()).matchAll(/<Key>(.*?)<\/Key>/g), (match) => match[1]);
  };

  it("keeps one object, read in both forms and listed in the form last written", async () => {
    const fake = fakeAt();
    expect((await put(fake, nfc, "first")).status).toBe(200);
    expect((await put(fake, nfd, "second")).status).toBe(200);
    expect(fake.keys()).toEqual([nfd]);
    const bodies = [nfc, nfd].map(async (key) => (await call(fake, "GET", `/${encodeURIComponent(key)}`)).text());
    expect(await Promise.all(bodies)).toEqual(["second", "second"]);
    // Also under a prefix in the other form.
    expect([await listed(fake, "caf\u00e9"), await listed(fake, "cafe\u0301")]).toEqual([[nfd], [nfd]]);
  });

  it("answers 412 to a create-only PUT in the other form, and deletes in either form", async () => {
    const fake = fakeAt();
    expect((await put(fake, nfd, "kept")).status).toBe(200);
    expect((await put(fake, nfc, "refused", { "if-none-match": "*" })).status).toBe(412);
    expect((await call(fake, "DELETE", `/${encodeURIComponent(nfc)}`)).status).toBe(204);
    expect((await call(fake, "HEAD", `/${encodeURIComponent(nfd)}`)).status).toBe(404);
  });
});
