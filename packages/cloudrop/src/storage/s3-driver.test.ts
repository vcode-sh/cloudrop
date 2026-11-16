import { describe, expect, it } from "vitest";
import type { Result } from "../errors.ts";
import { R2_RULES } from "../rules.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import type { StorageDriver } from "./driver.ts";
import { credentials, driverWith, endpoint, lastModified, neverCalled, now, setup } from "./s3/driver-fixture.ts";
import { createS3Driver } from "./s3-driver.ts";

describe("createS3Driver", () => {
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
        return new Response(body, {
          headers: { etag: '"e"', "content-length": "1", "last-modified": lastModified },
        });
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
});
