// The presets' environment settings (M4-F16, M4-F17): read on first use, so a build without secrets can import the
// server; explicit options are still checked at construction, and development still checks everything at start.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { ACCOUNT, firstUseError, goodS3, thrownBy } from "../testing/presets-fixture.ts";
import { r2, s3 } from "./presets.ts";

const credentials = { accessKeyId: "key", secretAccessKey: "secret" };

afterEach(() => vi.unstubAllEnvs());

function stubR2Env(values: Record<string, string>): void {
  for (const setting of ["BUCKET", "ACCOUNT_ID", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) {
    vi.stubEnv(`CLOUDROP_R2_${setting}`, values[setting] ?? "");
  }
}

describe("storage presets and the environment", () => {
  it("r2() takes every setting, the bucket included, from the environment", async () => {
    stubR2Env({ BUCKET: "media", ACCOUNT_ID: ACCOUNT, ACCESS_KEY_ID: "key", SECRET_ACCESS_KEY: "secret" });
    const fake = createFakeR2({ bucket: "media", credentials });
    expect(await r2({ fetch: fake.fetch }).head("a.txt")).toEqual({ data: null, error: null });
  });

  it("s3() takes every setting from the environment, and an empty option counts as unset", async () => {
    vi.stubEnv("CLOUDROP_S3_ENDPOINT", "http://127.0.0.1:19000");
    vi.stubEnv("CLOUDROP_S3_REGION", "eu-west-1");
    vi.stubEnv("CLOUDROP_S3_BUCKET", "media");
    vi.stubEnv("CLOUDROP_S3_ACCESS_KEY_ID", "key");
    vi.stubEnv("CLOUDROP_S3_SECRET_ACCESS_KEY", "secret");
    const requests: Request[] = [];
    const driver = s3({
      endpoint: "",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 404 });
      },
    });
    await driver.head("a");
    expect(requests[0]?.url).toBe("http://127.0.0.1:19000/media/a");
    expect(requests[0]?.headers.get("authorization")).toContain("Credential=key/");
    expect(requests[0]?.headers.get("authorization")).toContain("/eu-west-1/s3/aws4_request");
  });

  it("lets an explicit s3() option win over its variable", async () => {
    vi.stubEnv("CLOUDROP_S3_BUCKET", "from-env");
    const requests: Request[] = [];
    await s3({
      ...goodS3,
      bucket: "from-option",
      fetch: async (input) => {
        requests.push(new Request(input));
        return new Response(null, { status: 404 });
      },
    }).head("a");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/from-option/a");
  });

  it.for([
    { name: "an r2() bucket name", make: () => r2({ bucket: "Media" }), says: "The R2 bucket name must be" },
    { name: "an r2() account ID", make: () => r2({ accountId: "abc" }), says: "The R2 account ID must be" },
    { name: "an s3() endpoint", make: () => s3({ endpoint: "ftp://s3.example.com" }), says: "http or https URL" },
    { name: "an s3() region", make: () => s3({ region: "eu west" }), says: "The region setting must be" },
    {
      name: "an r2() secret access key",
      make: () => r2({ secretAccessKey: "secret\n" }),
      says: "The secretAccessKey setting must be",
    },
  ])("checks $name at construction while the other settings wait for the environment", ({ make, says }) => {
    stubR2Env({});
    expect(thrownBy(make)).toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining(says) });
  });

  it("checks a variable's value on first use, by the variable's setting", async () => {
    stubR2Env({ BUCKET: "media", ACCOUNT_ID: "not-an-account", ACCESS_KEY_ID: "key", SECRET_ACCESS_KEY: "secret" });
    expect((await firstUseError(r2()))?.message).toContain("The R2 account ID must be 32 hexadecimal characters");
  });

  it("reads the environment again until the settings are complete, then keeps them", async () => {
    stubR2Env({ BUCKET: "media" });
    const fake = createFakeR2({ bucket: "media", credentials });
    const driver = r2({ fetch: fake.fetch });
    expect((await firstUseError(driver))?.code).toBe("INVALID_CONFIG");
    stubR2Env({ BUCKET: "media", ACCOUNT_ID: ACCOUNT, ACCESS_KEY_ID: "key", SECRET_ACCESS_KEY: "secret" });
    expect(await driver.head("a.txt")).toEqual({ data: null, error: null });
    stubR2Env({});
    expect(await driver.head("a.txt")).toEqual({ data: null, error: null });
  });

  it("checks the environment at construction in development, so a dev server fails at start", () => {
    vi.stubEnv("NODE_ENV", "development");
    stubR2Env({ BUCKET: "media" });
    expect(thrownBy(() => r2())).toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("Missing R2 settings: accountId (CLOUDROP_R2_ACCOUNT_ID)"),
    });
  });

  it("keeps the rules and publicUrl, which need no environment value, readable before first use", () => {
    stubR2Env({});
    const driver = r2({ publicUrl: "https://cdn.example.com/files/" });
    expect({ publicUrl: driver.publicUrl, maxObjectSize: driver.rules.maxObjectSize }).toEqual({
      publicUrl: "https://cdn.example.com/files",
      maxObjectSize: 5 * 1024 ** 4 - 5 * 1024 ** 3,
    });
  });
});
