import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import type { FetchLike } from "./driver.ts";
import { r2, type S3Options, s3 } from "./presets.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV_NAMES = ["CLOUDROP_R2_ACCOUNT_ID", "CLOUDROP_R2_ACCESS_KEY_ID", "CLOUDROP_R2_SECRET_ACCESS_KEY"] as const;

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
  for (const name of ENV_NAMES) vi.stubEnv(name, values[name]);
}

afterEach(() => vi.unstubAllEnvs());

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
  it("reports every missing setting in one message, naming the option and the environment variable", () => {
    setEnv({});
    expect(thrownBy(() => r2({ bucket: "media" }))).toMatchObject({
      name: "CloudropError",
      code: "INVALID_CONFIG",
      message:
        "Missing R2 settings: accountId (CLOUDROP_R2_ACCOUNT_ID), accessKeyId (CLOUDROP_R2_ACCESS_KEY_ID), secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY). Pass them to r2(); a setting with a variable name in parentheses can also come from the environment.",
    });
  });

  it("names only what is missing", () => {
    setEnv({ CLOUDROP_R2_ACCOUNT_ID: ACCOUNT });
    expect(thrownBy(() => r2({ bucket: "media", accessKeyId: "k" })).message).toContain(
      "Missing R2 settings: secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY).",
    );
  });

  it("treats a call without options like an empty options object", () => {
    setEnv({});
    const error = thrownBy(() => (r2 as () => unknown)());
    expect(error.message).toContain("Missing R2 settings: bucket, accountId (CLOUDROP_R2_ACCOUNT_ID)");
  });

  it("rejects an account ID of the wrong shape, saying its length but never its value", () => {
    const error = thrownBy(() => r2({ ...goodR2, accountId: "my-secret-account" }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toBe(
      "The R2 account ID must be 32 hexadecimal characters (0-9, a-f); the one given has 17 characters. Copy it from the R2 overview page in the Cloudflare dashboard.",
    );
  });

  it("accepts an upper-case account ID and signs for the lower-case host", async () => {
    const { fetch, requests } = capture();
    await r2({ ...goodR2, accountId: ACCOUNT.toUpperCase(), fetch }).head("a");
    expect(new URL(requests[0]?.url ?? "").host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
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

  it.each(["EU", "us", ""])("rejects the jurisdiction %j", (jurisdiction) => {
    expect(thrownBy(() => r2({ ...goodR2, jurisdiction: jurisdiction as "eu" }))).toMatchObject({
      code: "INVALID_CONFIG",
      message: 'The R2 jurisdiction must be "eu" or "fedramp". Omit it for the default location.',
    });
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
    ["legacy upper case with underscore", "My_Legacy_Bucket"],
    ["empty", ""],
  ] as const;

  it.each(rejected)("r2() rejects a bucket name that is %s", (_why, bucket) => {
    const error = thrownBy(() => r2({ ...goodR2, bucket }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain(bucket === "" ? "Missing R2 settings: bucket" : "bucket name");
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

  it("pins the R2 and S3 bucket messages", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: "Media" })).message).toBe(
      "The R2 bucket name must be 3 to 63 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit. Copy the exact name from your R2 bucket list.",
    );
    expect(thrownBy(() => s3({ ...goodS3, bucket: "my..media" })).message).toBe(
      "The S3 bucket name must be 3 to 63 characters: lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit, with no two dots in a row, and not formatted like an IP address. Copy the exact name from your S3 bucket list.",
    );
  });

  it.each([".media", "media.", "-media", "media-"])("s3() rejects the edge character in %s", (bucket) => {
    expect(thrownBy(() => s3({ ...goodS3, bucket })).code).toBe("INVALID_CONFIG");
  });

  it("rejects a bucket that is not a string, as plain-JavaScript callers can pass one", () => {
    expect(thrownBy(() => r2({ ...goodR2, bucket: 42 as unknown as string })).message).toContain("bucket name");
  });
});

describe("publicUrl", () => {
  it.each([
    ["r2", (publicUrl: string) => r2({ ...goodR2, publicUrl })],
    ["s3", (publicUrl: string) => s3({ ...goodS3, publicUrl })],
  ] as const)("%s() passes it to the driver, keeping a CDN path and dropping trailing slashes", (_name, make) => {
    expect(make("https://cdn.example.com/files//").publicUrl).toBe("https://cdn.example.com/files");
    expect(make("https://cdn.example.com/").publicUrl).toBe("https://cdn.example.com");
  });

  it("leaves the driver's publicUrl undefined when none is given", () => {
    expect(r2(goodR2).publicUrl).toBeUndefined();
    expect(s3(goodS3).publicUrl).toBeUndefined();
  });

  it.each(["cdn.example.com", "ftp://cdn.example.com", "", "https://u:p@cdn.example.com"])(
    "rejects %j without echoing it",
    (publicUrl) => {
      for (const make of [() => r2({ ...goodR2, publicUrl }), () => s3({ ...goodS3, publicUrl })]) {
        const error = thrownBy(make);
        expect(error.message).toBe(
          "The publicUrl must be an absolute http or https URL without credentials, such as https://cdn.example.com/files.",
        );
      }
    },
  );
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

  it("reports every missing setting in one message", () => {
    expect(thrownBy(() => s3({} as S3Options)).message).toBe(
      "Missing S3 settings: endpoint, region, bucket, accessKeyId, secretAccessKey. Pass them to s3().",
    );
    expect(thrownBy(() => s3({ ...goodS3, region: "", accessKeyId: "" })).message).toBe(
      "Missing S3 settings: region, accessKeyId. Pass them to s3().",
    );
    expect(thrownBy(() => (s3 as () => unknown)()).message).toContain("Missing S3 settings: endpoint");
  });

  it("rejects credentials embedded in the endpoint without echoing them", () => {
    const error = thrownBy(() => s3({ ...goodS3, endpoint: "https://AK123:SK456@s3.example.com" }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("Do not put credentials in the endpoint");
    expect(error.message).not.toMatch(/AK123|SK456/);
  });
});

describe("the public entry", () => {
  it("exports exactly the intended runtime names", async () => {
    expect(Object.keys(await import("../index.ts")).sort()).toEqual(["CloudropError", "r2", "s3"]);
  });
});
