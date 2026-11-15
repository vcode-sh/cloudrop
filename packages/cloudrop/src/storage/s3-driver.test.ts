import { describe, expect, it } from "vitest";
import type { Result } from "../errors.ts";
import { MiB, R2_RULES } from "../rules.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { offsetBytes } from "../testing/storage-contract.ts";
import type { FetchLike, StorageDriver } from "./driver.ts";
import { createS3Driver } from "./s3-driver.ts";
import { sha256Hex, signRequest } from "./sigv4.ts";

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

// fetch streams a Blob body; loading it whole (arrayBuffer, text) is what put must never do.
class StreamOnlyBlob extends Blob {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("put loaded the Blob into memory"));
  }
  override text(): Promise<string> {
    return Promise.reject(new Error("put loaded the Blob into memory"));
  }
}

class UnreadableBlob extends StreamOnlyBlob {
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream({
      pull: (controller) => controller.error(new DOMException("The file could not be read.", "NotReadableError")),
    });
  }
}

/** Stores an object the way another tool would, with headers the driver itself refuses to send. */
async function putWithForeignTool(
  fetch: FetchLike,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
) {
  const url = new URL(`${endpoint}/test/${key}`);
  const payloadHash = await sha256Hex(body);
  const signed = await signRequest({
    method: "PUT",
    url,
    headers,
    credentials,
    region: "auto",
    date: signedAt,
    payloadHash,
  });
  expect((await fetch(url, { method: "PUT", headers: signed, body })).status).toBe(200);
}

/** Answers a copy: HEAD with the given source size, create and abort as R2 does, and the copy itself with `onCopy`. */
function copyStub(size: number, onCopy: FetchLike, aborted: string[] = []): FetchLike {
  return async (input, init) => {
    if (init?.method === "HEAD")
      return new Response(null, { headers: { "content-length": String(size), etag: '"src"' } });
    if (init?.method === "POST") {
      return new Response("<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
    }
    if (init?.method === "DELETE") {
      aborted.push(new URL(String(input)).searchParams.get("uploadId") ?? "");
      return new Response(null, { status: 204 });
    }
    return onCopy(input, init);
  };
}

describe("createS3Driver", () => {
  // The contract suite covers type, disposition, metadata and odd keys on every backend; it cannot pin a time.
  it("reads the upload time from Last-Modified", async () => {
    const { driver } = setup();
    expect((await driver.put("a.txt", "x")).error).toBeNull();
    expect((await driver.head("a.txt")).data?.uploadedAt).toEqual(signedAt);
  });

  it("keeps stored headers the driver would not accept as input when it copies in parts", async () => {
    const { fake, driver } = setup();
    // An underscore in a metadata name fails cloudrop's input rules, but the copy must keep what is stored.
    await putWithForeignTool(fake.fetch, "source.bin", offsetBytes(12 * MiB), {
      "content-type": "application/x-test",
      "x-amz-meta-legacy_id": "s1",
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
      type: "application/x-test",
      metadata: { legacy_id: "s1" },
    });
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

  it("puts a Blob without loading it into memory", async () => {
    const { driver } = setup();
    expect((await driver.put("blob.bin", new StreamOnlyBlob([offsetBytes(1024)]))).error).toBeNull();
    // 1020 = 0x000003fc.
    expect((await driver.getRange("blob.bin", 1020, 1023)).data).toEqual(new Uint8Array([0x00, 0x00, 0x03, 0xfc]));
  });

  it("puts an ArrayBuffer", async () => {
    const { driver } = setup();
    expect((await driver.put("buffer.bin", offsetBytes(8).buffer)).error).toBeNull();
    expect((await driver.getRange("buffer.bin", 4, 7)).data).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x04]));
  });

  it("rejects an oversized Blob without reading it", async () => {
    const tiny = createS3Driver({
      endpoint,
      region: "auto",
      bucket: "test",
      credentials,
      rules: { ...R2_RULES, maxSinglePutSize: 4 },
      fetch: neverCalled,
      now,
    });
    expect((await tiny.put("a.bin", new UnreadableBlob([new Uint8Array(5)]))).error).toMatchObject({
      code: "INVALID_INPUT",
      message: "Size is over the limit of 4 bytes. Upload a smaller file or split it.",
    });
  });

  it("reports a Blob that cannot be read as a failed request, without throwing", async () => {
    const { driver } = setup();
    const result = await driver.put("a.bin", new UnreadableBlob([new Uint8Array(5)]));
    expect(result.error).toMatchObject({ code: "STORAGE_UNREACHABLE", retryable: true });
  });

  it("accepts missing or null options from plain JavaScript", async () => {
    const { fake, driver } = setup();
    expect((await driver.put("a.txt", "x", null as never)).error).toBeNull();
    const created = await driver.createMultipart("b.bin", undefined as never);
    if (created.error) throw created.error;
    const { uploadId } = created.data;
    const signed = await driver.presignPart("b.bin", uploadId, 1, { size: 1, expiresIn: 60 });
    if (signed.error) throw signed.error;
    await fake.fetch(signed.data.url, { method: "PUT", headers: signed.data.headers, body: new Uint8Array(1) });
    const parts = await driver.listParts("b.bin", uploadId);
    if (parts.error) throw parts.error;
    expect((await driver.completeMultipart("b.bin", uploadId, parts.data, null as never)).error).toBeNull();
    expect((await driver.list("", null as never)).data?.items.map((item) => item.key)).toEqual(["a.txt", "b.bin"]);
  });

  it("deletes more keys than one S3 batch holds and fails an invalid key without a request", async () => {
    let deletes = 0;
    const counting = stubbed(async () => {
      deletes += 1;
      return new Response(null, { status: 204 });
    });
    const keys = Array.from({ length: 1001 }, (_, index) => `k${index}`);
    const result = await driverWith(counting).deleteMany([...keys, "bad/../key"]);
    expect(result.data?.deleted.toSorted()).toEqual(keys.toSorted());
    expect(result.data?.failed).toEqual([
      { key: "bad/../key", error: expect.objectContaining({ code: "INVALID_INPUT" }) },
    ]);
    expect(deletes).toBe(1001);
  });

  it("presigns a PUT of exactly the single-PUT limit and rejects one byte more", async () => {
    const driver = driverWith(neverCalled);
    const options = { type: "video/mp4", expiresIn: 60 };
    const atLimit = await driver.presignPut("movie.mp4", { ...options, size: R2_RULES.maxSinglePutSize });
    expect(atLimit.data).toEqual({
      method: "PUT",
      url: expect.any(String),
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
  const typeMessage = 'The content type must be printable ASCII, such as "text/plain; charset=utf-8".';
  const sizeMessage = "Size must be a whole number of bytes, zero or more.";
  const partsMessage =
    "Pass at least one part, each with a part number between 1 and 10000 and the ETag the storage returned for it.";
  const metadataMessage = 'Metadata must be an object of names and text values, such as { "cloudrop-id": "f1" }.';
  const bufferMessage =
    "The body's buffer is detached or shared (a SharedArrayBuffer). Copy the bytes into a new Uint8Array first.";
  const detachedBuffer = () => {
    const buffer = new ArrayBuffer(4);
    buffer.transfer();
    return buffer;
  };
  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, string]>([
    ["a '..' key segment", (driver) => driver.head("a/../b"), keyMessage],
    [
      "a non-ASCII content disposition",
      (driver) => driver.put("a.txt", "x", { disposition: 'attachment; filename="łódź.txt"' }),
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
    [
      "a missing body",
      (driver) => driver.put("a.txt", undefined as never),
      "The body must be a Uint8Array, an ArrayBuffer, a string or a Blob.",
    ],
    ["a numeric content type on put", (driver) => driver.put("a.txt", "x", { type: 5 as never }), typeMessage],
    // Object.entries would read a string or an array as metadata named "0", "1"...
    ["metadata given as a string", (driver) => driver.put("a.txt", "x", { metadata: "ab" as never }), metadataMessage],
    ["metadata given as an array", (driver) => driver.put("a.txt", "x", { metadata: ["x"] as never }), metadataMessage],
    // Hashing either one would throw a TypeError out of put.
    [
      "a body over a SharedArrayBuffer",
      (driver) => driver.put("a.txt", new Uint8Array(new SharedArrayBuffer(4)) as never),
      bufferMessage,
    ],
    ["a detached ArrayBuffer body", (driver) => driver.put("a.txt", detachedBuffer()), bufferMessage],
    [
      "a part over the part size limit",
      (driver) => driver.presignPart("a.txt", "u", 1, { size: R2_RULES.maxPartSize + 1, expiresIn: 60 }),
      "The part is over the part size limit of 4.995 GiB. Use smaller parts.",
    ],
    [
      "a numeric content type on presignPut",
      (driver) => driver.presignPut("a.txt", { ...presignOptions, type: 5 as never }),
      typeMessage,
    ],
    ["missing presignPut options", (driver) => driver.presignPut("a.txt", undefined as never), sizeMessage],
    ["missing presignPart options", (driver) => driver.presignPart("a.txt", "u", 1, undefined as never), sizeMessage],
    ["parts that are not a list", (driver) => driver.completeMultipart("a.txt", "u", null as never), partsMessage],
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
    ["an empty part list", (driver) => driver.completeMultipart("a.txt", "u", []), partsMessage],
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
      "keys that are not a list",
      (driver) => driver.deleteMany("a.txt" as never),
      "deleteMany takes an array of keys. Wrap a single key in an array.",
    ],
  ])("rejects %s before any request", async (_name, call, message) => {
    const result = await call(driverWith(neverCalled));
    expect(result.error).toMatchObject({ code: "INVALID_INPUT", retryable: false, message });
  });

  it.each([
    ["a query", `${endpoint}?x-id=1`],
    ["a fragment", `${endpoint}#bucket`],
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
          "The storage endpoint must be an http or https URL with no query or fragment, such as https://<account ID>.r2.cloudflarestorage.com.",
      }),
    );
  });

  const badEscapeMessage =
    "The storage endpoint's path contains a malformed percent escape, or one that is not valid UTF-8 (such as %zz or %FF). Write a literal percent sign as %25.";
  it.each([
    [
      "user info",
      "https://user:pass@account.r2.cloudflarestorage.com",
      "The storage endpoint contains a user name or password. Remove it; cloudrop takes credentials only as accessKeyId and secretAccessKey.",
    ],
    ["a malformed escape at the end of the path", `${endpoint}/a%`, badEscapeMessage],
    ["an escape that is not valid UTF-8 at the end of the path", `${endpoint}/a%E2%82`, badEscapeMessage],
    ["a lone continuation byte as the path", `${endpoint}/%FF`, badEscapeMessage],
    ["a malformed escape inside the path", `${endpoint}/a%zz/b`, badEscapeMessage],
  ])("rejects an endpoint with %s when it is created, naming the problem", (_name, badEndpoint, message) => {
    expect(() =>
      createS3Driver({ endpoint: badEndpoint, region: "auto", bucket: "test", credentials, rules: R2_RULES }),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIG", message }));
  });

  it("accepts an escaped slash in the endpoint's path and signs the path as sent", async () => {
    const paths: string[] = [];
    const driver = createS3Driver({
      endpoint: `${endpoint}/a%2Fb`,
      region: "auto",
      bucket: "test",
      credentials,
      rules: R2_RULES,
      now,
      fetch: async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return new Response(null, { status: 404 });
      },
    });
    expect((await driver.head("k")).error).toBeNull();
    expect(paths).toEqual(["/a%2Fb/test/k"]);
  });

  it("signs and sends every request under the endpoint's path prefix, but names a copy source without it", async () => {
    const requests: (string | null)[][] = [];
    const driver = createS3Driver({
      endpoint: `${endpoint}/cdn-cgi/s3/`,
      region: "auto",
      bucket: "test",
      credentials,
      rules: R2_RULES,
      now,
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        requests.push([
          method,
          new URL(input.toString()).pathname,
          new Headers(init?.headers).get("x-amz-copy-source"),
        ]);
        const body = new Headers(init?.headers).has("x-amz-copy-source")
          ? "<CopyObjectResult><ETag>&quot;e&quot;</ETag></CopyObjectResult>"
          : null;
        return new Response(body, { headers: { etag: '"e"', "content-length": "1" } });
      },
    });
    expect((await driver.put("a b.txt", "x")).error).toBeNull();
    expect((await driver.copy("a b.txt", "c.txt")).error).toBeNull();
    expect(requests).toEqual([
      ["PUT", "/cdn-cgi/s3/test/a%20b.txt", null],
      ["HEAD", "/cdn-cgi/s3/test/a%20b.txt", null],
      ["PUT", "/cdn-cgi/s3/test/c.txt", "/test/a%20b.txt"],
    ]);
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

  it("never passes on a platform error that quotes the Authorization header", async () => {
    const changing = { ...credentials };
    const driver = createS3Driver({ endpoint, region: "auto", bucket: "test", credentials: changing, rules: R2_RULES });
    // Construction refuses a line break, so only a value changed afterwards reaches fetch, which refuses the header and
    // (on Node) quotes it, access key ID and signature included.
    changing.accessKeyId = "AKIDEXAMPLE\n";
    expect((await driver.head("a.txt")).error).toMatchObject({ code: "STORAGE_UNREACHABLE", cause: undefined });
  });

  it("reports an unreachable endpoint as retryable, never as a missing object", async () => {
    const result = await driverWith(stubbed(() => Promise.reject(new TypeError("fetch failed")))).head("a.txt");
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ code: "STORAGE_UNREACHABLE", retryable: true });
  });

  it("reports a HEAD answer without a size as a retryable storage error, never as an empty object", async () => {
    const sizeless = stubbed(async () => new Response(null, { headers: { etag: '"e"' } }));
    expect((await driverWith(sizeless).head("a.txt")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no content length. Retry the request.",
    });
  });

  it.each([
    ["without an ETag", {}],
    ["with a quoted empty ETag", { etag: '""' }],
  ])("reports a HEAD answer %s as a retryable storage error", async (_name, etag) => {
    // copy() sends the ETag as x-amz-copy-source-if-match; an empty one would not guard the copy at all.
    const etagless = stubbed(async () => new Response(null, { headers: { "content-length": "1", ...etag } }));
    expect((await driverWith(etagless).head("a.txt")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no ETag. Retry the request.",
    });
  });

  const quote = "Invalid header value: AWS4-HMAC-SHA256 Credential=AKID/...";
  // Ten wrappers around a harmless error: past the inspected depth, so its contents are unknown.
  const deepChain = Array.from({ length: 10 }).reduce<Error>(
    (cause) => new Error("wrapped", { cause }),
    new Error("getaddrinfo ENOTFOUND"),
  );
  it.each([
    ["an Error quoting credentials", new Error(quote)],
    ["a plain object quoting credentials", { message: quote }],
    ["a string quoting credentials", quote],
    ["more links than it inspects", deepChain],
  ])("drops a platform error whose cause chain holds %s", async (_name, cause) => {
    const quoting = stubbed(() => Promise.reject(new TypeError("fetch failed", { cause })));
    expect((await driverWith(quoting).head("a.txt")).error).toMatchObject({
      code: "STORAGE_UNREACHABLE",
      cause: undefined,
    });
  });

  it("keeps a platform error's cause when nothing in its chain quotes credentials", async () => {
    const plain = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    const result = await driverWith(stubbed(() => Promise.reject(plain))).head("a.txt");
    expect(result.error?.cause).toBe(plain);
  });

  const unreadableCause = {
    get message(): string {
      throw new Error("The message cannot be read.");
    },
  };
  const opaqueCause = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("The prototype cannot be read.");
      },
    },
  );
  it.each([
    ["a getter", unreadableCause],
    ["a proxy", opaqueCause],
  ])("drops %s it cannot inspect without throwing", async (_name, cause) => {
    const result = await driverWith(stubbed(() => Promise.reject(cause))).head("a.txt");
    expect(result.error).toMatchObject({ code: "STORAGE_UNREACHABLE", retryable: true, cause: undefined });
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

  it.each([
    ["a single", 5],
    ["a multipart", R2_RULES.maxSinglePutSize + 1],
  ])("gives %s server-side copy five minutes per request", async (_name, size) => {
    const result = await driverWith(copyStub(size, timesOut)).copy("a.txt", "b.txt");
    expect(result.error?.message).toBe("The storage service did not answer within 300 seconds. Retry the request.");
  });

  it("aborts a multipart copy whose part result has no ETag", async () => {
    const aborted: string[] = [];
    const noEtag = stubbed(async () => new Response("<CopyPartResult></CopyPartResult>"));
    const result = await driverWith(copyStub(R2_RULES.maxSinglePutSize + 1, noEtag, aborted)).copy("a.txt", "b.txt");
    expect(result.error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no ETag. Retry the request.",
    });
    expect(aborted).toEqual(["u1"]);
  });

  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, FetchLike]>([
    [
      "completion",
      (driver) => driver.completeMultipart("a.txt", "u", [{ partNumber: 1, etag: "e" }]),
      stubbed(async () => new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>")),
    ],
    [
      "single copy",
      (driver) => driver.copy("a.txt", "b.txt"),
      copyStub(
        5,
        stubbed(async () => new Response("<CopyObjectResult></CopyObjectResult>")),
      ),
    ],
  ])("reports a successful %s without an ETag as a retryable storage error", async (_name, call, fetch) => {
    expect((await call(driverWith(fetch))).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no ETag. Retry the request.",
    });
  });

  it("reports a truncated object list without a continuation token instead of ending early", async () => {
    const truncated = stubbed(
      async () => new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"),
    );
    expect((await driverWith(truncated).list("")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no continuation token. Retry the request.",
    });
  });

  it("maps throttling to RATE_LIMITED", async () => {
    const throttled = stubbed(
      async () => new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 429 }),
    );
    expect((await driverWith(throttled).put("a.txt", "x")).error?.code).toBe("RATE_LIMITED");
  });

  const hidden = stubbed(async () => new Response("<Error><Code>InternalError</Code></Error>", { status: 200 }));
  it.each<[string, (driver: StorageDriver) => Promise<Result<unknown>>, FetchLike]>([
    ["completeMultipart", (driver) => driver.completeMultipart("a", "u", [{ partNumber: 1, etag: "e" }]), hidden],
    ["copy", (driver) => driver.copy("a", "b"), copyStub(5, hidden)],
  ])("treats a 200 response with an Error body from %s as a retryable failure", async (_name, call, fetch) => {
    expect((await call(driverWith(fetch))).error).toMatchObject({
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

  it("completes with the parts in ascending order and their ETags escaped and quoted once", async () => {
    let sent = "";
    const capture: FetchLike = async (_input, init) => {
      sent = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response('<CompleteMultipartUploadResult><ETag>"x-2"</ETag></CompleteMultipartUploadResult>');
    };
    const parts = [
      { partNumber: 2, etag: "b&" },
      // As a browser reads it from the part's ETag response header, quotes included.
      { partNumber: 1, etag: '"a<"' },
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

describe("presignGet", () => {
  it("serves the object through the URL, with the signed download name", async () => {
    const { fake, driver } = setup();
    expect((await driver.put("docs/report.txt", "hello", { type: "text/plain" })).error).toBeNull();
    const signed = await driver.presignGet("docs/report.txt", {
      expiresIn: 300,
      disposition: 'attachment; filename="report.txt"',
    });
    expect(signed.data?.expiresAt).toEqual(new Date("2026-11-15T12:05:00Z"));
    const response = await fake.fetch(signed.data?.url ?? "");
    expect({
      status: response.status,
      disposition: response.headers.get("content-disposition"),
      body: await response.text(),
    }).toEqual({ status: 200, disposition: 'attachment; filename="report.txt"', body: "hello" });
  });

  it("signs the same URL for the same signing time, so a rounded time gives one cacheable URL", async () => {
    const { driver } = setup();
    const signedAt = new Date("2026-11-15T11:00:00Z");
    const first = await driver.presignGet("a.txt", { expiresIn: 7200, signedAt });
    const second = await driver.presignGet("a.txt", { expiresIn: 7200, signedAt });
    expect(first.data?.url).toBe(second.data?.url);
    expect(first.data?.url).toContain("X-Amz-Date=20261115T110000Z");
    expect(first.data?.expiresAt).toEqual(new Date("2026-11-15T13:00:00Z"));
  });

  it.each<[string, unknown, string]>([
    [
      "an expiry over seven days",
      { expiresIn: 604_801 },
      "Expiry must be a whole number of seconds between 1 and 604800.",
    ],
    [
      "a disposition outside printable ASCII",
      { expiresIn: 60, disposition: 'attachment; filename="ü.txt"' },
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
    [
      "an invalid signing time",
      { expiresIn: 60, signedAt: new Date(Number.NaN) },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "a signing time before 1970",
      { expiresIn: 60, signedAt: new Date("1969-12-31T23:59:59Z") },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "a signing time in the year 10000",
      { expiresIn: 60, signedAt: new Date("+010000-01-01T00:00:00Z") },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "an expiry that ends in the year 10000",
      { expiresIn: 3600, signedAt: new Date("9999-12-31T23:30:00Z") },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    // Plain-JavaScript callers: none of these may throw a TypeError past the Result.
    ["null options", null, "Expiry must be a whole number of seconds between 1 and 604800."],
    [
      "a signing time given as text",
      { expiresIn: 60, signedAt: "2026-11-15T11:00:00Z" },
      "signedAt must be a valid Date from 1970 on, and the URL must expire before the year 10000. Pass a Date, or omit it to sign at the current time.",
    ],
    [
      "a disposition that is not text",
      { expiresIn: 60, disposition: 1 },
      "The content disposition must be printable ASCII. Percent-encode other characters, for example filename*=UTF-8''r%C3%A9sum%C3%A9.txt.",
    ],
  ])("refuses %s without signing", async (_name, options, message) => {
    expect((await driverWith(neverCalled).presignGet("a.txt", options as { expiresIn: number })).error).toMatchObject({
      code: "INVALID_INPUT",
      message,
    });
  });
});

describe("bucket configuration", () => {
  const cors =
    "<CORSConfiguration><CORSRule><AllowedOrigin>http://localhost:5173</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-meta-*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>";
  // R2's default multipart rule, plus a prefix-scoped expiry such as the test bucket's.
  const lifecycle =
    "<LifecycleConfiguration><Rule><ID>Default Multipart Abort Rule</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule><Rule><ID>live-test</ID><Status>Disabled</Status><Filter><Prefix>live-test/</Prefix></Filter><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>";

  function configured(bucketConfig?: { cors?: string; lifecycle?: string }): StorageDriver {
    return driverWith(createFakeR2({ bucket: "test", credentials, now, bucketConfig }).fetch);
  }

  it("reads the CORS rules", async () => {
    expect((await configured({ cors }).getBucketCors()).data).toEqual([
      {
        allowedOrigins: ["http://localhost:5173"],
        allowedMethods: ["PUT", "GET"],
        allowedHeaders: ["content-type", "x-amz-meta-*"],
        exposeHeaders: ["ETag"],
      },
    ]);
  });

  it("reads the lifecycle rules with their abort days and prefixes", async () => {
    expect((await configured({ lifecycle }).getBucketLifecycle()).data).toEqual([
      { id: "Default Multipart Abort Rule", enabled: true, prefix: "", abortIncompleteMultipartUploadDays: 7 },
      { id: "live-test", enabled: false, prefix: "live-test/" },
    ]);
  });

  it("answers no rules for a bucket without configuration", async () => {
    const driver = configured({});
    expect([(await driver.getBucketCors()).data, (await driver.getBucketLifecycle()).data]).toEqual([[], []]);
  });

  it.each([
    ["CORS", (driver: StorageDriver) => driver.getBucketCors(), "CORS configuration"],
    ["lifecycle", (driver: StorageDriver) => driver.getBucketLifecycle(), "lifecycle configuration"],
  ])(
    "reports a %s answer without its configuration element as a retryable storage error",
    async (_name, read, missing) => {
      // An HTML error page from a proxy is not "no rules": checkBucket would report rules the bucket may have.
      const html = stubbed(async () => new Response("<html><body>Bad gateway</body></html>"));
      expect((await read(driverWith(html))).error).toMatchObject({
        code: "STORAGE_ERROR",
        retryable: true,
        message: `The storage service's response had no ${missing}. Retry the request.`,
      });
    },
  );

  it.each([
    ["CORS", (driver: StorageDriver) => driver.getBucketCors(), "CORS"],
    ["lifecycle", (driver: StorageDriver) => driver.getBucketLifecycle(), "lifecycle"],
  ])(
    "reports a %s 404 without the missing-configuration code as a retryable storage error",
    async (_name, read, setting) => {
      // A proxy or a wrong endpoint path also answers 404; only the storage's own code means "no configuration".
      const proxy = stubbed(async () => new Response("<html><body>Not found</body></html>", { status: 404 }));
      expect((await read(driverWith(proxy))).error).toMatchObject({
        code: "STORAGE_ERROR",
        retryable: true,
        message: `The storage service answered 404 without saying that the bucket has no ${setting} configuration. Check the endpoint, then retry.`,
      });
    },
  );

  it("reports malformed abort days as a retryable storage error, never as NaN", async () => {
    const malformed = lifecycle.replace("<DaysAfterInitiation>7<", "<DaysAfterInitiation>seven<");
    expect((await configured({ lifecycle: malformed }).getBucketLifecycle()).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The storage service's response had no valid multipart abort days. Retry the request.",
    });
  });

  it("reports a refused read as STORAGE_DENIED, never as no rules", async () => {
    const driver = configured();
    expect([(await driver.getBucketCors()).error?.code, (await driver.getBucketLifecycle()).error?.code]).toEqual([
      "STORAGE_DENIED",
      "STORAGE_DENIED",
    ]);
  });
});
