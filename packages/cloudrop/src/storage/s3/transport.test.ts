import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../../errors.ts";
import { MiB, R2_RULES } from "../../rules.ts";
import { copyStub, credentials, driverWith, endpoint, stubbed, timesOut } from "../../testing/driver-fixture.ts";
import type { FetchLike, StorageDriver } from "../driver.ts";
import { createS3Driver } from "../s3-driver.ts";

describe("createS3Driver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  /** An answer whose body is 32 chunks of 1 MiB, the first starting with `start`, and what the driver did with it. */
  function megabytes(status: number, start = "") {
    const read = { chunks: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        pull(controller) {
          if (read.chunks === 32) return controller.close();
          const chunk = new Uint8Array(MiB);
          if (read.chunks === 0) chunk.set(new TextEncoder().encode(start));
          read.chunks += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          read.cancelled = true;
        },
      },
      // Nothing is produced ahead of a read, so the count is what the driver asked for.
      { highWaterMark: 0 },
    );
    return { fetch: stubbed(async () => new Response(body, { status })), read };
  }
  const tooLarge = "The storage endpoint sent more data than an S3 answer holds. Check the endpoint setting.";

  it("reads only the start of an error body, where S3 names its code", async () => {
    const { fetch, read } = megabytes(403, "<Error><Code>AccessDenied</Code>");
    expect((await driverWith(fetch).list("")).error).toMatchObject({
      code: "STORAGE_DENIED",
      storageCode: "AccessDenied",
    });
    expect(read).toEqual({ chunks: 1, cancelled: true });
  });

  it("stops reading a listing larger than any S3 listing of 1,000 keys", async () => {
    const { fetch, read } = megabytes(200, "<ListBucketResult>");
    expect((await driverWith(fetch).list("")).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: false,
      message: tooLarge,
    });
    // 8 MiB is the limit, so the ninth chunk is the first one past it.
    expect(read).toEqual({ chunks: 9, cancelled: true });
  });

  it("cuts off a ranged answer that carries more bytes than the range", async () => {
    const { fetch, read } = megabytes(206);
    expect((await driverWith(fetch).getRange("a.txt", 0, 4095)).error).toMatchObject({
      code: "STORAGE_ERROR",
      message: tooLarge,
    });
    expect(read).toEqual({ chunks: 1, cancelled: true });
  });

  it("returns a ranged answer of exactly the bytes asked for, sent in pieces", async () => {
    const pieces = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const partial = stubbed(async () => new Response(pieces, { status: 206 }));
    expect((await driverWith(partial).getRange("a.txt", 0, 3)).data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  // jsdom 26, Vitest's jsdom environment until jsdom 27, has a Blob without arrayBuffer() (M11-R2, M11-R250).
  it("reads an answer where the environment's Blob has no arrayBuffer()", async () => {
    const answer = stubbed(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 206 }));
    vi.stubGlobal("Blob", class Blob {});

    expect((await driverWith(answer).getRange("a.txt", 0, 3)).data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  /** An answer as node-fetch and cross-fetch give it: the body is a Node stream, which has no reader (M11-R251). */
  function nodeStreamAnswer(status: number, text: string) {
    const bytes = new TextEncoder().encode(text);
    const body = Readable.from([bytes]);
    const answer = {
      ok: status < 300,
      status,
      redirected: false,
      headers: new Headers(),
      body,
      arrayBuffer: async () => bytes.buffer,
    };
    return { fetch: stubbed(async () => answer as unknown as Response), body };
  }

  it("reads an answer whose body is a Node stream", async () => {
    const result = await driverWith(nodeStreamAnswer(206, "abcd").fetch).getRange("a.txt", 0, 3);
    expect(result.data).toEqual(new Uint8Array([97, 98, 99, 100]));
  });

  it("reads the code of an error whose body is a Node stream", async () => {
    const denied = nodeStreamAnswer(403, "<Error><Code>AccessDenied</Code></Error>").fetch;
    expect((await driverWith(denied).list("")).error).toMatchObject({
      code: "STORAGE_DENIED",
      storageCode: "AccessDenied",
    });
  });

  it("refuses a Node stream that held more bytes than the range, once it is read", async () => {
    expect((await driverWith(nodeStreamAnswer(206, "abcde").fetch).getRange("a.txt", 0, 3)).error).toMatchObject({
      code: "STORAGE_ERROR",
      message: tooLarge,
    });
  });

  it("destroys an unread Node stream and says the byte range was ignored", async () => {
    const { fetch, body } = nodeStreamAnswer(200, "whole object");
    expect((await driverWith(fetch).getRange("a.txt", 0, 3)).error).toMatchObject({
      code: "STORAGE_ERROR",
      message: "The storage service ignored the byte range. Check that the endpoint supports ranged GET.",
    });
    expect(body.destroyed).toBe(true);
  });
});
