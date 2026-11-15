import { describe, expect, it } from "vitest";
import type { Result } from "../errors.ts";
import { MiB, R2_RULES } from "../rules.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import type { FetchLike, StorageDriver } from "./driver.ts";
import { createS3Driver } from "./s3-driver.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
const endpoint = "https://account.r2.cloudflarestorage.com";
const signedAt = new Date("2026-11-15T12:00:00Z");
const now = () => signedAt;

function setup() {
  const fake = createFakeR2({ bucket: "test", credentials, now });
  const driver = createS3Driver({
    endpoint,
    region: "auto",
    bucket: "test",
    credentials,
    rules: R2_RULES,
    fetch: fake.fetch,
    now,
  });
  return { fake, driver };
}

function driverWith(fetch: FetchLike): StorageDriver {
  return createS3Driver({ endpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES, fetch, now });
}

const stubbed =
  (respond: () => Promise<Response>): FetchLike =>
  () =>
    respond();
const neverCalled = stubbed(() => Promise.reject(new Error("must not be called")));

describe("createS3Driver", () => {
  it("round-trips a Unicode key with type, disposition and metadata", async () => {
    const { driver } = setup();
    const key = "zdjęcia/łódź (1).txt";
    expect(
      (await driver.put(key, "hello", { type: "text/plain", disposition: "inline", metadata: { "cloudrop-id": "f1" } }))
        .error,
    ).toBeNull();
    expect((await driver.head(key)).data).toMatchObject({
      key,
      size: 5,
      type: "text/plain",
      disposition: "inline",
      uploadedAt: signedAt,
      metadata: { "cloudrop-id": "f1" },
    });
  });

  it("uploads through presigned part URLs and joins the parts in order", async () => {
    const { fake, driver } = setup();
    const body = offsetBytes(7 * MiB);
    const created = await driver.createMultipart("big.bin", { type: "application/octet-stream" });
    if (created.error) throw created.error;
    const { uploadId } = created.data;
    const sendPart = async (partNumber: number, part: Uint8Array<ArrayBuffer>) => {
      const signed = await driver.presignPart("big.bin", uploadId, partNumber, { size: part.length, expiresIn: 60 });
      if (signed.error) throw signed.error;
      return (await fake.fetch(signed.data.url, { method: "PUT", headers: signed.data.headers, body: part })).status;
    };
    expect(await sendPart(1, body.slice(0, 5 * MiB))).toBe(200);
    expect(await sendPart(2, body.slice(5 * MiB))).toBe(200);
    const parts = await driver.listParts("big.bin", uploadId);
    if (parts.error) throw parts.error;
    expect(parts.data.map((part) => [part.partNumber, part.size])).toEqual([
      [1, 5 * MiB],
      [2, 2 * MiB],
    ]);
    expect((await driver.completeMultipart("big.bin", uploadId, parts.data)).error).toBeNull();
    expect((await driver.head("big.bin")).data?.size).toBe(7 * MiB);
    // 5 MiB = 0x00500000; the word before it holds 0x004ffffc.
    expect((await driver.getRange("big.bin", 5 * MiB - 2, 5 * MiB + 1)).data).toEqual(
      new Uint8Array([0xff, 0xfc, 0x00, 0x50]),
    );
    expect(fake.pendingUploads()).toBe(0);
  });

  it("copies objects above the single-PUT limit in parts and keeps their headers", async () => {
    const { fake, driver } = setup();
    await driver.put("source.bin", offsetBytes(12 * MiB), {
      type: "application/x-test",
      metadata: { "cloudrop-id": "s1" },
    });
    // Same bucket, lower single-PUT limit, so a 12 MiB copy takes the multipart path without a 5 GiB fixture.
    const small = createS3Driver({
      endpoint,
      region: "auto",
      bucket: "test",
      credentials,
      rules: { ...R2_RULES, maxSinglePutSize: 6 * MiB },
      fetch: fake.fetch,
      now,
    });
    expect((await small.copy("source.bin", "copy.bin")).error).toBeNull();
    expect((await driver.head("copy.bin")).data).toMatchObject({
      size: 12 * MiB,
      type: "application/x-test",
      metadata: { "cloudrop-id": "s1" },
    });
    // The two 6 MiB parts meet at 0x00600000; the word before it holds 0x005ffffc.
    expect((await driver.getRange("copy.bin", 6 * MiB - 2, 6 * MiB + 1)).data).toEqual(
      new Uint8Array([0xff, 0xfc, 0x00, 0x60]),
    );
    expect(fake.pendingUploads()).toBe(0);
  });

  it("lists a prefix with a space, a plus and a star, page by page", async () => {
    const { driver } = setup();
    const prefix = "dir with space+plus*/";
    await driver.put(`${prefix}a.txt`, "a");
    await driver.put(`${prefix}b.txt`, "bb");
    // A "+" read as a space would match this decoy.
    await driver.put("dir with space plus*/decoy.txt", "c");
    const first = await driver.list(prefix, { limit: 1 });
    if (first.error) throw first.error;
    expect(first.data.items).toEqual([
      expect.objectContaining({ key: `${prefix}a.txt`, size: 1, uploadedAt: signedAt }),
    ]);
    const second = await driver.list(prefix, { limit: 1, cursor: first.data.nextCursor ?? "" });
    expect(second.data).toEqual({
      items: [expect.objectContaining({ key: `${prefix}b.txt`, size: 2 })],
      nextCursor: null,
    });
  });

  it("deletes many keys and reports each one", async () => {
    const { driver } = setup();
    await driver.put("a.txt", "a");
    await driver.put("b.txt", "b");
    const result = await driver.deleteMany(["a.txt", "bad/../key", "b.txt", "missing.txt"]);
    if (result.error) throw result.error;
    expect(result.data.deleted.toSorted()).toEqual(["a.txt", "b.txt", "missing.txt"]);
    expect(result.data.failed).toEqual([
      { key: "bad/../key", error: expect.objectContaining({ code: "INVALID_INPUT" }) },
    ]);
    expect((await driver.list("")).data).toEqual({ items: [], nextCursor: null });
  });

  it("presigns a PUT of exactly the single-PUT limit and rejects one byte more", async () => {
    const driver = driverWith(neverCalled);
    const options = { type: "video/mp4", expiresIn: 60 };
    const atLimit = await driver.presignPut("movie.mp4", { ...options, size: R2_RULES.maxSinglePutSize });
    expect(atLimit.data).toMatchObject({
      method: "PUT",
      // Content-Length is signed but not returned: browsers refuse to set it.
      headers: { "content-type": "video/mp4" },
      expiresAt: new Date("2026-11-15T12:01:00Z"),
    });
    const overLimit = await driver.presignPut("movie.mp4", { ...options, size: R2_RULES.maxSinglePutSize + 1 });
    expect(overLimit.error?.code).toBe("INVALID_INPUT");
  });

  const keyMessage = "The object key contains a '.' or '..' segment. Use plain path segments.";
  const checksumMessage =
    'The CRC32C checksum must be the base64 of 4 bytes, such as "4waSgw==". Compute it from the exact bytes you send.';
  const uploadIdMessage = "The upload ID is empty or malformed. Pass the uploadId that createMultipart returned.";
  const expiryMessage = "Expiry must be a whole number of seconds between 1 and 604800.";
  const presignOptions = { size: 1, expiresIn: 60 };
  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, string]>([
    ["a '..' key segment", (driver) => driver.head("a/../b"), keyMessage],
    [
      "a non-ASCII content disposition",
      (driver) => driver.put("a.txt", "x", { disposition: 'attachment; filename="łódź.txt"' }),
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
    ["a NaN expiry", (driver) => driver.presignPut("a.txt", { size: 1, expiresIn: Number.NaN }), expiryMessage],
    [
      "an expiry that prints as 1e+21",
      (driver) => driver.presignPart("a.txt", "u", 1, { size: 1, expiresIn: 1e21 }),
      expiryMessage,
    ],
    [
      "a malformed checksum on presignPut",
      (driver) => driver.presignPut("a.txt", { ...presignOptions, checksumCrc32c: "4waSgw=" }),
      checksumMessage,
    ],
    [
      "a malformed checksum on presignPart",
      (driver) => driver.presignPart("a.txt", "u", 1, { ...presignOptions, checksumCrc32c: "abc" }),
      checksumMessage,
    ],
    [
      "a malformed checksum on put",
      (driver) => driver.put("a.txt", "x", { checksumCrc32c: "4waSgw==x" }),
      checksumMessage,
    ],
    [
      "an empty upload ID on presignPart",
      (driver) => driver.presignPart("a.txt", "", 1, presignOptions),
      uploadIdMessage,
    ],
    ["an upload ID with a space on listParts", (driver) => driver.listParts("a.txt", "a b"), uploadIdMessage],
    [
      "an empty upload ID on completeMultipart",
      (driver) => driver.completeMultipart("a.txt", "", [{ partNumber: 1, etag: "e" }]),
      uploadIdMessage,
    ],
    ["an empty upload ID on abortMultipart", (driver) => driver.abortMultipart("a.txt", ""), uploadIdMessage],
    [
      "an empty part list",
      (driver) => driver.completeMultipart("a.txt", "u", []),
      "Pass at least one part, each with a part number between 1 and 10000 and the ETag the storage returned for it.",
    ],
    ["a page size of 0", (driver) => driver.list("", { limit: 0 }), "The page size must be between 1 and 1000."],
    [
      "an empty cursor",
      (driver) => driver.list("", { cursor: "" }),
      "The list cursor is empty or malformed. Pass the nextCursor of the previous page.",
    ],
    [
      "a prefix with a lone surrogate",
      (driver) => driver.list("a\uD800"),
      "The list prefix is not valid Unicode (it has a lone surrogate). Remove or replace that character.",
    ],
    [
      "1001 keys to delete",
      (driver) => driver.deleteMany(Array.from({ length: 1001 }, (_, index) => `k${index}`)),
      "deleteMany takes an array of at most 1000 keys. Split longer lists into batches.",
    ],
  ])("rejects %s before any request", async (_name, call, message) => {
    const result = await call(driverWith(neverCalled));
    expect(result.error).toMatchObject({ code: "INVALID_INPUT", retryable: false, message });
  });

  it.each([
    ["a path", `${endpoint}/prefix`],
    ["a query", `${endpoint}?x-id=1`],
    ["a fragment", `${endpoint}#bucket`],
    ["user info", "https://user:pass@account.r2.cloudflarestorage.com"],
    ["no scheme", "account.r2.cloudflarestorage.com"],
    ["a malformed escape in the host", "https://acc%zzount.r2.cloudflarestorage.com"],
    ["a non-HTTP scheme", "ftp://account.r2.cloudflarestorage.com"],
  ])("rejects an endpoint with %s when it is created", (_name, badEndpoint) => {
    expect(() =>
      createS3Driver({ endpoint: badEndpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "The storage endpoint must be an http or https origin with no path, query or fragment, such as https://<account ID>.r2.cloudflarestorage.com.",
      }),
    );
  });

  it("accepts an endpoint with a trailing slash", async () => {
    const fake = createFakeR2({ bucket: "test", credentials, now });
    const driver = createS3Driver({
      endpoint: `${endpoint}/`,
      region: "auto",
      bucket: "test",
      credentials,
      rules: R2_RULES,
      fetch: fake.fetch,
      now,
    });
    expect((await driver.put("a.txt", "x")).error).toBeNull();
    expect((await driver.head("a.txt")).data?.size).toBe(1);
  });

  it("reports an unreachable endpoint as retryable, never as a missing object", async () => {
    const result = await driverWith(stubbed(() => Promise.reject(new TypeError("fetch failed")))).head("a.txt");
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ code: "STORAGE_UNREACHABLE", retryable: true });
  });

  it("reports a refused HEAD as an error, never as a missing object", async () => {
    const result = await driverWith(stubbed(async () => new Response(null, { status: 403 }))).head("a.txt");
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("STORAGE_DENIED");
  });

  // The stub times out only requests that carry a signal, so a request sent without a timeout fails the message check.
  const timesOut: FetchLike = async (_input, init) => {
    if (!(init?.signal instanceof AbortSignal)) throw new TypeError("sent without a timeout");
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, number]>([
    ["HEAD", (driver) => driver.head("a.txt"), 30],
    ["PUT of just over 1 MiB, allowing 1 MiB/s", (driver) => driver.put("a.txt", new Uint8Array(MiB + 1)), 32],
    [
      "completion, which S3 may take minutes to finish",
      (driver) => driver.completeMultipart("a.txt", "u", [{ partNumber: 1, etag: "e" }]),
      300,
    ],
  ])("reports a timed-out %s as retryable and says how long it waited", async (_name, call, seconds) => {
    const result = await call(driverWith(timesOut));
    expect(result.error).toMatchObject({
      code: "STORAGE_UNREACHABLE",
      retryable: true,
      message: `The storage service did not answer within ${seconds} seconds. Retry the request.`,
    });
  });

  it("gives a server-side copy five minutes", async () => {
    const copyTimesOut: FetchLike = async (input, init) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 200, headers: { "content-length": "5" } })
        : timesOut(input, init);
    const result = await driverWith(copyTimesOut).copy("a.txt", "b.txt");
    expect(result.error?.message).toBe("The storage service did not answer within 300 seconds. Retry the request.");
  });

  it("maps throttling to RATE_LIMITED", async () => {
    const throttled = stubbed(
      async () => new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 429 }),
    );
    expect((await driverWith(throttled).put("a.txt", "x")).error?.code).toBe("RATE_LIMITED");
  });

  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>]>([
    ["completeMultipart", (driver) => driver.completeMultipart("a", "u", [{ partNumber: 1, etag: "e" }])],
    ["copy", (driver) => driver.copy("a", "b")],
  ])("treats a 200 response with an Error body from %s as a retryable failure", async (_name, call) => {
    const hidden = stubbed(async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }));
    expect((await call(driverWith(hidden))).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      storageCode: "InternalError",
    });
  });

  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, Response, string | null]>([
    [
      "aborts an upload the storage no longer knows",
      (driver) => driver.abortMultipart("a", "u"),
      new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }),
      null,
    ],
    [
      "reports a refused abort",
      (driver) => driver.abortMultipart("a", "u"),
      new Response(null, { status: 403 }),
      "STORAGE_DENIED",
    ],
    [
      "deletes a key the storage no longer has",
      (driver) => driver.delete("a"),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      null,
    ],
    ["reports a refused delete", (driver) => driver.delete("a"), new Response(null, { status: 403 }), "STORAGE_DENIED"],
  ])("%s", async (_name, call, response, code) => {
    expect((await call(driverWith(stubbed(async () => response)))).error?.code ?? null).toBe(code);
  });

  it("refuses a full body when the storage ignored the byte range", async () => {
    const result = await driverWith(stubbed(async () => new Response("whole object", { status: 200 }))).getRange(
      "a.txt",
      0,
      3,
    );
    expect(result.error).toMatchObject({
      code: "STORAGE_ERROR",
      status: 200,
      message: "The storage service ignored the byte range. Check that the endpoint supports ranged GET.",
    });
  });

  it("follows ListParts pagination with the marker the storage returned", async () => {
    const pages = [
      '<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1000</NextPartNumberMarker><Part><PartNumber>1000</PartNumber><ETag>"a"</ETag><Size>8388608</Size></Part></ListPartsResult>',
      '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1001</PartNumber><ETag>"b"</ETag><Size>5</Size></Part></ListPartsResult>',
    ];
    const markers: (string | null)[] = [];
    const fetch: FetchLike = async (input) => {
      markers.push(new URL(String(input)).searchParams.get("part-number-marker"));
      return new Response(pages[markers.length - 1], { status: 200 });
    };
    expect((await driverWith(fetch).listParts("big.bin", "upload-1")).data).toEqual([
      { partNumber: 1000, size: 8_388_608, etag: "a", checksumCrc32c: undefined },
      { partNumber: 1001, size: 5, etag: "b", checksumCrc32c: undefined },
    ]);
    expect(markers).toEqual(["0", "1000"]);
  });

  it("completes with the parts in ascending order and their ETags escaped", async () => {
    let sent = "";
    const capture: FetchLike = async (_input, init) => {
      sent = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response('<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>');
    };
    const parts = [
      { partNumber: 2, etag: "b&" },
      { partNumber: 1, etag: "a<" },
    ];
    expect((await driverWith(capture).completeMultipart("a", "u", parts)).data).toEqual({ etag: "x-2" });
    expect(sent).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"a&lt;"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"b&amp;"</ETag></Part></CompleteMultipartUpload>',
    );
  });

  it("stops when a truncated part list does not advance its marker", async () => {
    const stuck = stubbed(
      async () =>
        new Response(
          "<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>0</NextPartNumberMarker></ListPartsResult>",
        ),
    );
    expect((await driverWith(stuck).listParts("big.bin", "upload-1")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
    });
  });

  it("reports a create response without an upload ID as a retryable storage error", async () => {
    const empty = stubbed(async () => new Response("<InitiateMultipartUploadResult></InitiateMultipartUploadResult>"));
    expect((await driverWith(empty).createMultipart("a.txt", {})).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
    });
  });
});
