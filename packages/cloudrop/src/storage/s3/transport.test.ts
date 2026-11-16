import { describe, expect, it } from "vitest";
import type { Result } from "../../errors.ts";
import { MiB, R2_RULES } from "../../rules.ts";
import type { FetchLike, StorageDriver } from "../driver.ts";
import { createS3Driver } from "../s3-driver.ts";
import { copyStub, credentials, driverWith, endpoint, stubbed, timesOut } from "./driver-fixture.ts";

describe("createS3Driver", () => {
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
});
