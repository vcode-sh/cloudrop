import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { ACCOUNT, firstUseError, goodR2, goodS3, thrownBy } from "../testing/presets-fixture.ts";
import type { FetchLike } from "./driver.ts";
import { r2, s3 } from "./presets.ts";

const ENV_NAMES = [
  "CLOUDROP_R2_BUCKET",
  "CLOUDROP_R2_ACCOUNT_ID",
  "CLOUDROP_R2_ACCESS_KEY_ID",
  "CLOUDROP_R2_SECRET_ACCESS_KEY",
] as const;

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>): void {
  for (const name of ENV_NAMES) vi.stubEnv(name, values[name]);
}

const S3_ENV_NAMES = [
  "CLOUDROP_S3_ENDPOINT",
  "CLOUDROP_S3_REGION",
  "CLOUDROP_S3_BUCKET",
  "CLOUDROP_S3_ACCESS_KEY_ID",
  "CLOUDROP_S3_SECRET_ACCESS_KEY",
] as const;

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

describe("r2()", () => {
  it("reports every missing setting in one message on first use, naming the option and the environment variable", async () => {
    setEnv({});
    expect(await firstUseError(r2({ bucket: "media" }))).toMatchObject({
      name: "CloudropError",
      code: "INVALID_CONFIG",
      message:
        "Missing R2 settings: accountId (CLOUDROP_R2_ACCOUNT_ID), accessKeyId (CLOUDROP_R2_ACCESS_KEY_ID), secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY). Pass them to r2() or set the environment variables in parentheses.",
    });
  });

  it("names only what is missing", async () => {
    setEnv({ CLOUDROP_R2_ACCOUNT_ID: ACCOUNT });
    expect((await firstUseError(r2({ bucket: "media", accessKeyId: "k" })))?.message).toBe(
      "Missing R2 settings: secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY). Pass them to r2() or set the environment variables in parentheses.",
    );
  });

  it("reads every setting from the environment when called without options", async () => {
    setEnv({});
    expect((await firstUseError(r2()))?.message).toBe(
      "Missing R2 settings: bucket (CLOUDROP_R2_BUCKET), accountId (CLOUDROP_R2_ACCOUNT_ID), accessKeyId (CLOUDROP_R2_ACCESS_KEY_ID), secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY). Pass them to r2() or set the environment variables in parentheses.",
    );
  });

  it("rejects an account ID of the wrong shape, saying its length but never its value", () => {
    const error = thrownBy(() => r2({ ...goodR2, accountId: "my-secret-account" }));
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toBe(
      "The R2 account ID must be 32 hexadecimal characters (0-9, a-f); this one has 17 characters. Copy it from the R2 overview page in the Cloudflare dashboard.",
    );
  });

  it("accepts an upper-case account ID and signs for the lower-case host", async () => {
    const { fetch, requests } = capture();
    await r2({ ...goodR2, accountId: ACCOUNT.toUpperCase(), fetch }).head("a");
    expect(new URL(requests[0]?.url ?? "").host).toBe(`${ACCOUNT}.r2.cloudflarestorage.com`);
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

  // The whole message: an empty value read as set would be an invalid account ID, not a missing one.
  it("treats an empty environment variable as missing", async () => {
    setEnv({ CLOUDROP_R2_ACCOUNT_ID: "", CLOUDROP_R2_ACCESS_KEY_ID: "key", CLOUDROP_R2_SECRET_ACCESS_KEY: "secret" });
    expect((await firstUseError(r2({ bucket: "media" })))?.message).toBe(
      "Missing R2 settings: accountId (CLOUDROP_R2_ACCOUNT_ID). Pass them to r2() or set the environment variables in parentheses.",
    );
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

  it("keeps working where there is no process, and then names the missing setting", async () => {
    const original = globalThis.process;
    // @ts-expect-error simulating a Worker or a browser, where `process` is not defined
    delete globalThis.process;
    try {
      const fake = createFakeR2({ bucket: "media", credentials: { accessKeyId: "k", secretAccessKey: "s" } });
      expect(await r2({ ...goodR2, fetch: fake.fetch }).head("a")).toEqual({ data: null, error: null });
      expect((await firstUseError(r2({ bucket: "media" })))?.message).toContain("CLOUDROP_R2_ACCOUNT_ID");
    } finally {
      globalThis.process = original;
    }
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

  it.each(["storage.example.com", "https://s3.example.com?x=1", "ftp://s3.example.com"])(
    "rejects the endpoint %s at construction",
    (endpoint) => {
      expect(thrownBy(() => s3({ ...goodS3, endpoint }))).toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringContaining("http or https URL"),
      });
    },
  );

  it.each(["/a%zz", "/%FF"])("rejects the bad escape in the endpoint path %s at construction", (path) => {
    expect(thrownBy(() => s3({ ...goodS3, endpoint: `https://s3.example.com${path}` }))).toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("malformed percent escape"),
    });
  });

  it("reports every missing setting in one message on first use, naming the option and the environment variable", async () => {
    for (const name of S3_ENV_NAMES) vi.stubEnv(name, "");
    expect((await firstUseError(s3()))?.message).toBe(
      "Missing S3 settings: endpoint (CLOUDROP_S3_ENDPOINT), region (CLOUDROP_S3_REGION), bucket (CLOUDROP_S3_BUCKET), accessKeyId (CLOUDROP_S3_ACCESS_KEY_ID), secretAccessKey (CLOUDROP_S3_SECRET_ACCESS_KEY). Pass them to s3() or set the environment variables in parentheses.",
    );
    expect((await firstUseError(s3({ ...goodS3, region: "", accessKeyId: "" })))?.message).toBe(
      "Missing S3 settings: region (CLOUDROP_S3_REGION), accessKeyId (CLOUDROP_S3_ACCESS_KEY_ID). Pass them to s3() or set the environment variables in parentheses.",
    );
  });

  it("rejects credentials embedded in the endpoint without echoing them", () => {
    expect(thrownBy(() => s3({ ...goodS3, endpoint: "https://AK123:SK456@s3.example.com" }))).toMatchObject({
      code: "INVALID_CONFIG",
      message:
        "The storage endpoint contains a user name or password. Remove it; cloudrop takes credentials only as accessKeyId and secretAccessKey.",
    });
  });
});

describe("the public entry", () => {
  it("exports exactly the intended runtime names", async () => {
    expect(Object.keys(await import("../index.ts")).sort()).toEqual([
      "CloudropError",
      "allowAnyone",
      "createCloudrop",
      "forbidden",
      "r2",
      "route",
      "s3",
      "unauthorized",
    ]);
  });
});
