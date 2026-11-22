// Configuration from the environment (M4-F16): createCloudrop() starts without it, so `next build` needs no secret; the
// first request reads it, and a server missing it answers 500 and logs why once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { r2 } from "../storage/presets.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { uploadBody } from "../testing/handler-fixture.ts";
import { thrownBy } from "../testing/presets-fixture.ts";
import { APP_ORIGIN, recordingLogger, SECRET } from "../testing/server-fixture.ts";
import { createCloudrop } from "./cloudrop.ts";
import { allowAnyone, route } from "./route.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const credentials = { accessKeyId: "key", secretAccessKey: "secret" };
const routes = { avatar: route({ accept: "image/png", maxSize: "1MB", authorize: allowAnyone }) };
const VARIABLES = [
  "CLOUDROP_SECRET",
  "CLOUDROP_R2_ACCOUNT_ID",
  "CLOUDROP_R2_ACCESS_KEY_ID",
  "CLOUDROP_R2_SECRET_ACCESS_KEY",
];

const MISSING =
  "Missing R2 settings: accountId (CLOUDROP_R2_ACCOUNT_ID), accessKeyId (CLOUDROP_R2_ACCESS_KEY_ID), secretAccessKey (CLOUDROP_R2_SECRET_ACCESS_KEY). Pass them to r2() or set the environment variables in parentheses. Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); generate one with `openssl rand -base64 32`.";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  for (const name of VARIABLES) vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

const TRUSTED = "https://admin.example.com";

function server() {
  const fake = createFakeR2({ bucket: "uploads", credentials });
  const logger = recordingLogger();
  const storage = r2({ bucket: "uploads", fetch: fake.fetch });
  const cloudrop = createCloudrop({ storage, routes, logger, trustedOrigins: [TRUSTED] });
  const post = async (origin = APP_ORIGIN) => {
    const response = await cloudrop.handler(
      new Request(`${APP_ORIGIN}/api/cloudrop/upload`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(uploadBody),
      }),
    );
    return {
      status: response.status,
      allowOrigin: response.headers.get("access-control-allow-origin"),
      body: (await response.json()) as { error?: { code: string; message: string; retryable: boolean } },
    };
  };
  return { cloudrop, logger, post };
}

function setEnvironment(): void {
  vi.stubEnv("CLOUDROP_SECRET", SECRET);
  vi.stubEnv("CLOUDROP_R2_ACCOUNT_ID", ACCOUNT);
  vi.stubEnv("CLOUDROP_R2_ACCESS_KEY_ID", credentials.accessKeyId);
  vi.stubEnv("CLOUDROP_R2_SECRET_ACCESS_KEY", credentials.secretAccessKey);
}

describe("configuration from the environment", () => {
  it("answers every request a retryable 500 until the environment is set, logging what is missing once", async () => {
    const { logger, post } = server();
    const answers = [await post(), await post()];
    // Retryable: an upload in flight when a deploy goes live with a missing variable keeps its ticket and resume record
    // through the client's retries, and a fixed environment recovers it (M4-F16).
    const notReady = {
      code: "SERVER_ERROR",
      message: "The upload server is not ready. Try again in a moment.",
      retryable: true,
    };
    expect(answers.map(({ status, body }) => [status, body.error])).toEqual([
      [500, notReady],
      [500, notReady],
    ]);
    expect(logger.errors).toEqual([
      {
        message: `cloudrop: every request answers 500 until this is fixed. ${MISSING}`,
        error: expect.objectContaining({ code: "INVALID_CONFIG", message: MISSING }),
      },
    ]);
  });

  it("lets a trusted origin read the 500, so its page can show the error", async () => {
    const { post } = server();
    expect(await post(TRUSTED)).toMatchObject({ status: 500, allowOrigin: TRUSTED });
  });

  // Routing, method and preflight need no environment: they answer as on a configured server, and nothing is logged.
  it.for([
    {
      name: "a preflight",
      path: "upload",
      init: { method: "OPTIONS", headers: { origin: TRUSTED, "access-control-request-method": "POST" } },
      status: 204,
    },
    { name: "an unknown endpoint", path: "nowhere", init: { method: "POST" }, status: 404 },
    { name: "a GET", path: "upload", init: { method: "GET" }, status: 405 },
  ])("answers $name with $status without reading the environment", async ({ path, init, status }) => {
    const { cloudrop, logger } = server();
    const response = await cloudrop.handler(new Request(`${APP_ORIGIN}/api/cloudrop/${path}`, init));
    expect({ status: response.status, logged: logger.errors }).toEqual({ status, logged: [] });
  });

  it("names CLOUDROP_SECRET when the secret it holds is too short", async () => {
    setEnvironment();
    vi.stubEnv("CLOUDROP_SECRET", "too short");
    const { cloudrop } = server();
    expect((await cloudrop.api.headObject("a.png")).error).toMatchObject({
      code: "INVALID_CONFIG",
      message: "CLOUDROP_SECRET must be text of at least 32 characters. Generate one with `openssl rand -base64 32`.",
    });
  });

  it("gives cloudrop.api calls the INVALID_CONFIG with what is missing", async () => {
    const { cloudrop } = server();
    expect(await cloudrop.api.headObject("a.png")).toEqual({
      data: null,
      error: expect.objectContaining({ code: "INVALID_CONFIG", message: MISSING }),
    });
  });

  it("recovers without a restart once the environment is set", async () => {
    const { cloudrop, post } = server();
    expect((await post()).status).toBe(500);
    setEnvironment();
    expect((await post()).status).toBe(200);
    expect(await cloudrop.api.headObject("a.png")).toEqual({ data: null, error: null });
    // Once complete, the settings are kept for the life of the server.
    for (const name of VARIABLES) vi.stubEnv(name, "");
    expect((await post()).status).toBe(200);
  });

  it("checks the environment at construction in development, so `next dev` fails at start", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CLOUDROP_R2_ACCOUNT_ID", ACCOUNT);
    vi.stubEnv("CLOUDROP_R2_ACCESS_KEY_ID", "key");
    vi.stubEnv("CLOUDROP_R2_SECRET_ACCESS_KEY", "secret");
    expect(thrownBy(() => createCloudrop({ storage: r2({ bucket: "uploads" }), routes }))).toMatchObject({
      code: "INVALID_CONFIG",
      message:
        "Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); generate one with `openssl rand -base64 32`.",
    });
  });

  it("still checks a secret passed as an option at construction", () => {
    const storage = r2({ bucket: "uploads", accountId: ACCOUNT, ...credentials });
    expect(thrownBy(() => createCloudrop({ storage, routes, secret: "too short" }))).toMatchObject({
      code: "INVALID_CONFIG",
      message:
        "Each upload token secret must be text of at least 32 characters. Generate one with `openssl rand -base64 32`.",
    });
  });
});
