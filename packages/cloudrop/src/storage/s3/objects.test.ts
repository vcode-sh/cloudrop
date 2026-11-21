import { describe, expect, it } from "vitest";
import type { Result } from "../../errors.ts";
import { R2_RULES } from "../../rules.ts";
import {
  credentials,
  driverWith,
  endpoint,
  neverCalled,
  now,
  setup,
  signedAt,
  stubbed,
} from "../../testing/driver-fixture.ts";
import { offsetBytes } from "../../testing/storage-contract.ts";
import type { StorageDriver } from "../driver.ts";
import { createS3Driver } from "../s3-driver.ts";

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

describe("createS3Driver", () => {
  // The contract suite covers type, disposition, metadata and odd keys on every backend; it cannot pin a time.
  it("reads the upload time from Last-Modified", async () => {
    const { driver } = setup();
    expect((await driver.put("a.txt", "x")).error).toBeNull();
    expect((await driver.head("a.txt")).data?.uploadedAt).toEqual(signedAt);
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

  it("lists keys with a leading space, a trailing space and a trailing no-break space exactly as stored", async () => {
    const { driver } = setup();
    const keys = [" lead", "trail ", "nbsp\u00a0"];
    for (const key of keys) expect((await driver.put(key, "x")).error).toBeNull();
    expect((await driver.list("")).data?.items.map((item) => item.key).toSorted()).toEqual(keys.toSorted());
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

  it("reports a refused HEAD as an error, never as a missing object", async () => {
    const result = await driverWith(stubbed(async () => new Response(null, { status: 403 }))).head("a.txt");
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("STORAGE_DENIED");
  });

  it.each([
    { name: "ahead", minutes: 20 },
    { name: "behind", minutes: -20 },
  ])(
    "reports a HEAD refused for a signing clock 20 minutes $name as the clock, not the credentials",
    async ({ minutes }) => {
      // R2 answers a HEAD without a body, so only its Date header shows the skew (M9-H2).
      const { fake } = setup();
      const skewed = createS3Driver({
        endpoint,
        region: "auto",
        bucket: "test",
        credentials,
        rules: R2_RULES,
        fetch: fake.fetch,
        now: () => new Date(signedAt.getTime() + minutes * 60_000),
      });
      expect((await skewed.head("a.txt")).error).toMatchObject({
        code: "STORAGE_DENIED",
        message:
          "This server's clock is more than 15 minutes off from the storage service's clock. Sync the clock (NTP), then retry.",
      });
    },
  );

  it("keeps reporting a bare refused HEAD within the clock tolerance as a refusal of the credentials", async () => {
    const answeredAt = new Date(signedAt.getTime() + 14 * 60_000).toUTCString();
    const refused = stubbed(async () => new Response(null, { status: 403, headers: { date: answeredAt } }));
    expect((await driverWith(refused).head("a.txt")).error?.message).toBe(
      "The storage service refused the request. Check the access key, its permissions and the bucket name.",
    );
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

  // Until the fake answered as R2 does, only a stubbed 401 covered this (M9-H5).
  it("reports an access key ID the storage does not know as refused credentials, on HEAD and on a listing", async () => {
    const { fake } = setup();
    const stranger = createS3Driver({
      endpoint,
      region: "auto",
      bucket: "test",
      credentials: { ...credentials, accessKeyId: "0".repeat(32) },
      rules: R2_RULES,
      fetch: fake.fetch,
      now,
    });
    const message =
      "The storage service did not accept these credentials. Check the access key ID and the secret access key.";
    expect((await stranger.head("a.txt")).error).toMatchObject({ code: "STORAGE_DENIED", status: 401, message });
    expect((await stranger.list("")).error).toMatchObject({
      code: "STORAGE_DENIED",
      storageCode: "Unauthorized",
      message,
    });
  });

  // R2 keeps the NFC and NFD forms of a key as one object and lists the form last written (M9-H6).
  it("lists a key written in NFD under its NFC prefix, in NFD, and refuses to create its NFC form", async () => {
    const { driver } = setup();
    expect((await driver.put("Ame\u0301lie/a.txt", "x")).error).toBeNull();
    expect((await driver.list("Am\u00e9lie/")).data?.items.map((item) => item.key)).toEqual(["Ame\u0301lie/a.txt"]);
    expect((await driver.put("Am\u00e9lie/a.txt", "y", { ifNoneMatch: true })).error?.code).toBe("ALREADY_EXISTS");
  });
});
