import { describe, expect, it } from "vitest";
import { CloudropError, type CloudropErrorCode } from "../errors.ts";
import { avatar, outcome, setup, uploadBody } from "../testing/handler-fixture.ts";
import { APP_ORIGIN, serverFixture } from "../testing/server-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { route } from "./route.ts";

describe("cloudrop.handler failures", () => {
  it("answers a throwing callback with a generic 500 and logs the error itself", async () => {
    const secretDetail = new Error("db password=hunter2 at /srv/app/auth.ts:12");
    const failing = route({
      accept: "image/png",
      maxSize: "1MB",
      authorize: () => {
        throw secretDetail;
      },
    });
    const fixture = serverFixture({ avatar: failing });
    const response = await fixture.post("upload", uploadBody);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 500,
      body: {
        error: {
          code: "SERVER_ERROR",
          message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
          retryable: false,
        },
      },
    });
    expect(fixture.logger.errors).toEqual([
      { message: "cloudrop: /upload failed on the server.", error: secretDetail },
    ]);
  });

  // A logger is the application's code: if it fails while reporting, the handler must still answer.
  it.for<{ name: string; log: () => unknown }>([
    {
      name: "throws",
      log: () => {
        throw new Error("log sink down");
      },
    },
    { name: "returns a rejected promise", log: () => Promise.reject(new Error("log sink down")) },
    // Not a native Promise, so only a then() call marks the rejection it forwards as handled.
    {
      name: "returns a rejecting thenable",
      log: () => {
        const rejected = Promise.reject(new Error("log sink down"));
        // biome-ignore lint/suspicious/noThenProperty: a custom thenable is exactly what this row sends.
        return { then: (resolve: () => void, reject: (error: unknown) => void) => rejected.then(resolve, reject) };
      },
    },
  ])("still answers a generic 500 when the logger $name", async ({ log }) => {
    const failing = route({
      accept: "image/png",
      maxSize: "1MB",
      authorize: () => {
        throw new Error("authorize failed");
      },
    });
    const fixture = serverFixture({ avatar: failing }, { logger: { error: log, warn: log } });
    expect(await outcome(await fixture.post("upload", uploadBody))).toEqual({ status: 500, code: "SERVER_ERROR" });
  });

  // Adapters written in plain JavaScript may pass anything; the promise still resolves to a Response.
  it.for<{ name: string; input: unknown }>([
    { name: "null", input: null },
    { name: "an object shaped like a request", input: { url: `${APP_ORIGIN}/api/cloudrop/upload`, method: "POST" } },
  ])("answers $name instead of a Request with a generic 500 and logs it", async ({ input }) => {
    const fixture = setup();
    const response = await fixture.cloudrop.handler(input as Request);
    expect({ ...(await outcome(response)), logged: fixture.logger.errors.map(({ message }) => message) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: ["cloudrop: the handler failed before any endpoint ran. Pass it a Fetch API Request."],
    });
  });

  // CloudropError does not check its code: a plain-JS plugin can return any text, which has no HTTP status. The
  // client's own codes have none either: the server never sends them.
  it.each([{ code: "OUT_OF_CREDITS" }, { code: "ABORTED" }])(
    "answers a plugin refusal with the code $code, which the server cannot send, as a generic 500",
    async ({ code }) => {
      const plugin: CloudropPlugin = {
        id: "quota",
        server: { beforeUpload: () => new CloudropError(code as CloudropErrorCode, "No quota left.") },
      };
      const fixture = serverFixture({ avatar }, { plugins: [plugin] });
      const response = await fixture.post("upload", uploadBody);
      expect({ status: response.status, body: await response.json(), logged: fixture.logger.errors }).toEqual({
        status: 500,
        body: {
          error: {
            code: "SERVER_ERROR",
            message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
            retryable: false,
          },
        },
        logged: [
          {
            message:
              "cloudrop: /upload failed with an error code the server cannot send, so the client got a generic 500. Return a CloudropError with one of cloudrop's server codes, not a client-only code such as ABORTED.",
            error: expect.objectContaining({ code, message: "No quota left." }),
          },
        ],
      });
    },
  );

  // M11-K3. `content` is typed, but a plugin may pass a wider object or come from plain JavaScript: only the three
  // fields are sent, and only with the code they explain.
  const found = { declared: "image/png", detected: "image/jpeg", reason: "mismatch" } as const;
  it.for([
    {
      name: "sends a type refusal's content field by field",
      code: "FILE_TYPE_NOT_ALLOWED",
      expected: {
        status: 400,
        error: { code: "FILE_TYPE_NOT_ALLOWED", message: "Not this file.", retryable: false, content: found },
      },
    },
    {
      name: "sends no content with another code",
      code: "QUOTA_EXCEEDED",
      expected: { status: 403, error: { code: "QUOTA_EXCEEDED", message: "Not this file.", retryable: false } },
    },
  ] as const)("$name", async ({ code, expected }) => {
    const content = { ...found, key: "uploads/a.png", name: "a.png", bytes: [0xff, 0xd8] };
    const plugin: CloudropPlugin = {
      id: "types",
      server: { beforeUpload: () => new CloudropError(code, "Not this file.", { content }) },
    };
    const response = await serverFixture({ avatar }, { plugins: [plugin] }).post("upload", uploadBody);
    expect({ status: response.status, ...(await response.json()) }).toStrictEqual(expected);
  });

  it("marks every answer as not cacheable, since it carries tokens and signed URLs", async () => {
    const response = await setup().post("upload", uploadBody);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
