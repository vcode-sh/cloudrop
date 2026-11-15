import { afterEach, describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import type { FetchLike } from "./driver.ts";
import { r2, s3 } from "./presets.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV_NAMES = ["CLOUDROP_R2_ACCOUNT_ID", "CLOUDROP_R2_ACCESS_KEY_ID", "CLOUDROP_R2_SECRET_ACCESS_KEY"] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
  for (const name of ENV_NAMES) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function capture(): { fetch: FetchLike; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 404 });
    },
  };
}

const authorizationOf = (requests: Request[]): string => requests[0]?.headers.get("authorization") ?? "";

function thrownBy(run: () => unknown): CloudropError {
  try {
    run();
  } catch (error) {
    if (error instanceof CloudropError) return error;
    throw error;
  }
  throw new Error("Expected the call to throw a CloudropError.");
}

const goodR2 = { bucket: "media", accountId: ACCOUNT, accessKeyId: "k", secretAccessKey: "s" };
const goodS3 = {
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  bucket: "media",
  accessKeyId: "k",
  secretAccessKey: "s",
};

describe("r2()", () => {
  it("names the missing account ID and the environment variable that provides it", () => {
    setEnv({});
    const error = thrownBy(() => r2({ bucket: "media" }));
    expect(error).toMatchObject({
      name: "CloudropError",
      code: "INVALID_CONFIG",
      message: "The R2 account ID is missing. Pass it to r2() or set CLOUDROP_R2_ACCOUNT_ID.",
    });
  });

  it("names the missing access key ID and secret access key", () => {
    setEnv({ CLOUDROP_R2_ACCOUNT_ID: ACCOUNT });
    expect(thrownBy(() => r2({ bucket: "media" })).message).toBe(
      "The R2 access key ID is missing. Pass it to r2() or set CLOUDROP_R2_ACCESS_KEY_ID.",
    );
    expect(thrownBy(() => r2({ bucket: "media", accessKeyId: "k" })).message).toBe(
      "The R2 secret access key is missing. Pass it to r2() or set CLOUDROP_R2_SECRET_ACCESS_KEY.",
    );
  });

  it("rejects an account ID that is not 32 hexadecimal characters, without echoing it", () => {
    const error = thrownBy(() => r2({ ...goodR2, accountId: "my-secret-account" }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("32 hexadecimal characters");
    expect(error.message).not.toContain("my-secret-account");
  });

  it("never puts a credential in a configuration error", () => {
    const error = thrownBy(() =>
      r2({ bucket: "Bad_Bucket", accountId: ACCOUNT, accessKeyId: "ak-123", secretAccessKey: "sk-456" }),
    );
    expect(error.message).not.toMatch(/ak-123|sk-456/);
  });

  it("feeds each environment variable to the right credential", async () => {
    // The fake verifies the signature, so swapping the key ID and the secret makes the call fail.
    setEnv({
      CLOUDROP_R2_ACCOUNT_ID: ACCOUNT,
      CLOUDROP_R2_ACCESS_KEY_ID: "key",
      CLOUDROP_R2_SECRET_ACCESS_KEY: "secret",
    });
    const fake = createFakeR2({ bucket: "media", credentials: { accessKeyId: "key", secretAccessKey: "secret" } });
    expect(await r2({ bucket: "media", fetch: fake.fetch }).head("a.txt")).toEqual({ data: null, error: null });
  });

  it("signs for region auto against the account endpoint", async () => {
    setEnv({
      CLOUDROP_R2_ACCOUNT_ID: ACCOUNT,
      CLOUDROP_R2_ACCESS_KEY_ID: "key",
      CLOUDROP_R2_SECRET_ACCESS_KEY: "secret",
    });
    const { fetch, requests } = capture();
    await r2({ bucket: "media", fetch }).head("a.txt");
    const url = new URL(requests[0]?.url ?? "");
    expect(url.host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe("/media/a.txt");
    expect(authorizationOf(requests)).toContain("Credential=key/");
    expect(authorizationOf(requests)).toContain("/auto/s3/aws4_request");
  });

  it("lets an explicit option win over the environment", async () => {
    setEnv({
      CLOUDROP_R2_ACCOUNT_ID: "f".repeat(32),
      CLOUDROP_R2_ACCESS_KEY_ID: "env-key",
      CLOUDROP_R2_SECRET_ACCESS_KEY: "env-secret",
    });
    const { fetch, requests } = capture();
    await r2({
      bucket: "media",
      accountId: ACCOUNT,
      accessKeyId: "option-key",
      secretAccessKey: "option-secret",
      fetch,
    }).head("a");
    expect(new URL(requests[0]?.url ?? "").host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(authorizationOf(requests)).toContain("Credential=option-key/");
  });

  it("treats an empty environment variable as missing", () => {
    setEnv({ CLOUDROP_R2_ACCOUNT_ID: "" });
    expect(thrownBy(() => r2({ bucket: "media" })).message).toContain("CLOUDROP_R2_ACCOUNT_ID");
  });

  it.each(["eu", "fedramp"] as const)("uses the %s jurisdiction endpoint", async (jurisdiction) => {
    const { fetch, requests } = capture();
    await r2({ ...goodR2, jurisdiction, fetch }).head("a");
    expect(new URL(requests[0]?.url ?? "").host).toBe(`${ACCOUNT}.${jurisdiction}.r2.cloudflarestorage.com`);
  });

  it("keeps working where there is no process, and then names the missing setting", () => {
    const original = globalThis.process;
    // @ts-expect-error simulating a Worker or a browser, where `process` is not defined
    delete globalThis.process;
    try {
      expect(() => r2({ ...goodR2 })).not.toThrow();
      expect(thrownBy(() => r2({ bucket: "media" })).message).toContain("CLOUDROP_R2_ACCOUNT_ID");
    } finally {
      globalThis.process = original;
    }
  });

  it("exposes the R2 limits", () => {
    expect(r2(goodR2).rules.maxSinglePutSize).toBe(5 * 1024 ** 3 - 5 * 1024 ** 2);
  });
});

describe("bucket names", () => {
  const rejected = [
    ["too short", "ab"],
    ["too long", "a".repeat(64)],
    ["upper case", "Media"],
    ["underscore", "my_bucket"],
    ["leading hyphen", "-media"],
    ["trailing hyphen", "media-"],
    ["slash", "a/b"],
    ["empty", ""],
  ] as const;

  it.each(rejected)("r2() rejects a bucket name that is %s", (_why, bucket) => {
    const error = thrownBy(() => r2({ ...goodR2, bucket }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("bucket name");
  });

  it.each(rejected)("s3() rejects a bucket name that is %s", (_why, bucket) => {
    expect(thrownBy(() => s3({ ...goodS3, bucket })).code).toBe("INVALID_CONFIG");
  });

  it("accepts the shortest and the longest valid name", () => {
    expect(() => r2({ ...goodR2, bucket: "a1b" })).not.toThrow();
    expect(() => r2({ ...goodR2, bucket: `a${"-".repeat(61)}1` })).not.toThrow();
  });

  it("r2() rejects a dot, s3() accepts one but not an IP address or a double dot", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: "my.media" })).code).toBe("INVALID_CONFIG");
    expect(() => s3({ ...goodS3, bucket: "my.media" })).not.toThrow();
    expect(thrownBy(() => s3({ ...goodS3, bucket: "192.168.5.4" })).code).toBe("INVALID_CONFIG");
    expect(thrownBy(() => s3({ ...goodS3, bucket: "my..media" })).code).toBe("INVALID_CONFIG");
  });

  it("rejects a bucket that is not a string, as plain-JavaScript callers can pass one", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: undefined as unknown as string })).message).toContain("bucket name");
  });
});

describe("s3()", () => {
  it("signs for the given endpoint and region", async () => {
    const { fetch, requests } = capture();
    await s3({ ...goodS3, endpoint: "http://127.0.0.1:19000", bucket: "bkt", accessKeyId: "key", fetch }).head("a");
    expect(requests[0]?.url).toBe("http://127.0.0.1:19000/bkt/a");
    expect(authorizationOf(requests)).toContain("Credential=key/");
    expect(authorizationOf(requests)).toContain("/us-east-1/s3/aws4_request");
  });

  it("feeds the key ID and the secret to the right credential", async () => {
    const fake = createFakeR2({ bucket: "media", credentials: { accessKeyId: "key", secretAccessKey: "secret" } });
    const driver = s3({ ...goodS3, accessKeyId: "key", secretAccessKey: "secret", fetch: fake.fetch });
    expect(await driver.head("a")).toEqual({ data: null, error: null });
  });

  it("exposes the S3 limits", () => {
    expect(s3(goodS3).rules.maxSinglePutSize).toBe(5 * 1024 ** 3);
  });

  it.each(["storage.example.com", "https://s3.example.com/prefix", "ftp://s3.example.com"])(
    "rejects the endpoint %s at construction",
    (endpoint) => {
      expect(thrownBy(() => s3({ ...goodS3, endpoint }))).toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringContaining("http or https origin"),
      });
    },
  );

  it("names each missing setting", () => {
    expect(thrownBy(() => s3({ ...goodS3, region: "" })).message).toContain("region");
    expect(thrownBy(() => s3({ ...goodS3, accessKeyId: "" })).message).toContain("access key ID");
    expect(thrownBy(() => s3({ ...goodS3, secretAccessKey: "" })).message).toContain("secret access key");
  });
});
