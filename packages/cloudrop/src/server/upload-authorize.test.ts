import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudropError } from "../errors.ts";
import type { SingleTicket } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { albumSchema, NOW, png, upload } from "../testing/upload-fixture.ts";
import type { CloudropPlugin } from "./plugins.ts";
import { allowAnyone, forbidden, rateLimited, route, unauthorized } from "./route.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /upload: authorization comes first", () => {
  it.for([
    { name: "unauthorized()", refusal: unauthorized("Log in first."), status: 401, code: "UNAUTHORIZED" },
    // Signed in, but not allowed: quota, plan or role.
    { name: "forbidden()", refusal: forbidden("Your plan stores 1 GB."), status: 403, code: "FORBIDDEN" },
  ])("refuses with $name's status and message and starts nothing", async ({ refusal, status, code }) => {
    const fixture = serverFixture(
      { files: route({ accept: "*/*", maxSize: "1GB", authorize: () => refusal }) },
      { multipartThreshold: 0 },
    );
    const answer = await upload(fixture, { route: "files", files: [{ name: "a.bin", size: 9 * MiB, type: "" }] });
    expect({ status: answer.status, error: answer.body.error }).toEqual({
      status,
      error: { code, message: refusal.message, retryable: false },
    });
    expect(fixture.storageCalls).toEqual([]);
  });

  it("refuses forbidden() without a message with a sentence that says what happened and what to do", async () => {
    const fixture = serverFixture({ files: route({ accept: "*/*", maxSize: "1GB", authorize: () => forbidden() }) });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, error: body.error }).toEqual({
      status: 403,
      error: {
        code: "FORBIDDEN",
        message: "You are not allowed to upload files here. Ask the site owner for access if you think this is wrong.",
        retryable: false,
      },
    });
  });

  // The guide and the hooks' JSDoc say so (M11-R43): a hook reads the request's headers and url, never its body.
  it("gives authorize the request with its headers and url, and its body already read", async () => {
    const seen: unknown[] = [];
    const reading = route({
      accept: "*/*",
      maxSize: "1GB",
      authorize: ({ request }) => {
        seen.push({ user: request.headers.get("x-user"), url: request.url, bodyUsed: request.bodyUsed });
        return {};
      },
    });
    await upload(serverFixture({ files: reading }), { route: "files", files: [png()] });
    expect(seen).toEqual([{ user: "42", url: "https://app.example.com/api/cloudrop/upload", bodyUsed: true }]);
  });

  // The authorize result rides in every token, which the browser can read: it must be a small JSON object.
  it.for<{ name: string; auth: unknown; log: string }>([
    {
      name: "null",
      auth: null,
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized(), forbidden() or a CloudropError.',
    },
    // A Next.js habit: a 401 Response is an object, so a typeof check alone would sign for it.
    {
      name: "a Response",
      auth: new Response(null, { status: 401 }),
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized(), forbidden() or a CloudropError.',
    },
    {
      name: "an Error",
      auth: new Error("Not signed in"),
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized(), forbidden() or a CloudropError.',
    },
    // A refusal brand on a class instance is neither a refusal nor a user.
    {
      name: "a branded class instance",
      auth: Object.assign(new (class Denied {})(), { [Symbol.for("cloudrop.unauthorized")]: true, message: "No." }),
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized(), forbidden() or a CloudropError.',
    },
    // Its JSON is the text "x": the token would carry an owner that is not an object.
    {
      name: "a plain object whose JSON is not an object",
      auth: { toJSON: () => "x" },
      log: 'TypeError: Route "files": authorize returned an object whose toJSON does not give a JSON object. Return plain data or unauthorized().',
    },
    {
      name: "more than 2 KiB of JSON",
      auth: { record: "x".repeat(2048) },
      log: 'TypeError: Route "files": authorize returned more than 2 KiB of JSON. Return ids, not records.',
    },
  ])("answers 500 when authorize returns $name, and logs why", async ({ auth, log }) => {
    const fixture = serverFixture({ files: route({ accept: "*/*", maxSize: "1GB", authorize: () => auth as object }) });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, code: body.error?.code, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: log,
    });
  });

  // A plain-JS or foreign refusal without a usable message is still a refusal, with unauthorized()'s default text.
  it.for([
    { name: "no message", refusal: { [Symbol.for("cloudrop.unauthorized")]: true } },
    { name: "a numeric message", refusal: { [Symbol.for("cloudrop.unauthorized")]: true, message: 5 } },
  ])("refuses a branded refusal with $name with the default message", async ({ refusal }) => {
    const fixture = serverFixture({
      files: route({ accept: "*/*", maxSize: "1GB", authorize: () => refusal as object }),
    });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, error: body.error }).toEqual({
      status: 401,
      error: { code: "UNAUTHORIZED", message: "Sign in to upload files here.", retryable: false },
    });
  });

  // The cap and the token must read one serialization: a toJSON may answer differently for each key it is asked.
  it("signs the same owner JSON it measured, while prefix sees the live authorize result", async () => {
    const live = {
      userId: "42",
      toJSON: (key: string) => (key === "" ? { userId: "42" } : "x".repeat(5000)),
    };
    const fixture = serverFixture({
      files: route(
        { accept: "*/*", maxSize: "1GB", authorize: () => live },
        { prefix: (context) => (typeof context.toJSON === "function" ? `users/${context.userId}` : "lost") },
      ),
    });
    const { body } = await upload(fixture, { route: "files", files: [png()] });
    const ticket = body.files[0] as SingleTicket;
    expect({ key: ticket.key, owner: tokenPayload(ticket.token).owner }).toEqual({
      key: `users/42/${ticket.id}.png`,
      owner: { userId: "42" },
    });
  });

  it("recognises unauthorized() from another copy of cloudrop in the same app", async () => {
    // What a second installed version's unauthorized() returns: its own module, the same registered symbol.
    const foreign = { [Symbol.for("cloudrop.unauthorized")]: true, message: "Sign in first." };
    const fixture = serverFixture({
      files: route({ accept: "*/*", maxSize: "1GB", authorize: () => foreign as object }),
    });
    const { status, body } = await upload(fixture, { route: "files", files: [png()] });
    expect({ status, error: body.error }).toEqual({
      status: 401,
      error: { code: "UNAUTHORIZED", message: "Sign in first.", retryable: false },
    });
  });

  it("validates metadata before authorize sees it", async () => {
    const authorize = vi.fn(allowAnyone);
    const fixture = serverFixture({
      avatar: route({ accept: "image/png", maxSize: "1MB", metadata: albumSchema, authorize }),
    });
    const { status, body } = await upload(fixture, { route: "avatar", files: [png()], metadata: { albumId: 7 } });
    expect({ status, code: body.error?.code, calls: authorize.mock.calls.length }).toEqual({
      status: 400,
      code: "INVALID_METADATA",
      calls: 0,
    });
  });
});

// Spec 1.0 §2a (M12-E1 to M12-E3): authorize and beforeUpload refuse with a CloudropError of the codes /upload may send.
// Oracle: the spec's status table and rateLimited's wording; the body is what the client reads.
describe("POST /upload: authorize and beforeUpload refuse with a CloudropError", () => {
  const OTHER_ORIGIN = "https://admin.example.com";
  const refusing = (refusal: () => object) => route({ accept: "*/*", maxSize: "1GB", authorize: refusal });

  async function answer(fixture: ReturnType<typeof serverFixture>, headers: Record<string, string> = {}) {
    const response = await fixture.post("upload", { route: "files", files: [png()] }, headers);
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      exposed: response.headers.get("access-control-expose-headers"),
      body: await response.json(),
    };
  }

  it("answers rateLimited(30) with 429 and a Retry-After a cross-origin page can read, logging nothing", async () => {
    const fixture = serverFixture({ files: refusing(() => rateLimited(30)) }, { trustedOrigins: [OTHER_ORIGIN] });
    expect({ ...(await answer(fixture, { origin: OTHER_ORIGIN })), logged: fixture.logger.errors }).toEqual({
      status: 429,
      retryAfter: "30",
      exposed: "Retry-After",
      body: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many upload requests. Try again in 30 seconds.",
          retryable: true,
        },
      },
      logged: [],
    });
  });

  it("rounds a fraction of a second up to a Retry-After of 1, and says one second", async () => {
    const { retryAfter, body } = await answer(serverFixture({ files: refusing(() => rateLimited(0.2)) }));
    expect({ retryAfter, message: body.error.message }).toEqual({
      retryAfter: "1",
      message: "Too many upload requests. Try again in 1 second.",
    });
  });

  // M12-E3: 10^30 seconds would be written "1e+30", which is no Retry-After value; a day is the most ever sent, and the
  // message says the wait the header sends.
  it("caps Retry-After and the message's wait at a day, written as a plain integer", async () => {
    const { status, retryAfter, body } = await answer(serverFixture({ files: refusing(() => rateLimited(1e30)) }));
    expect({ status, retryAfter, message: body.error.message }).toEqual({
      status: 429,
      retryAfter: "86400",
      message: "Too many upload requests. Try again in 86400 seconds.",
    });
  });

  // M12-R33: from plain JavaScript a string may arrive; "It got 30." would read as though 30 had been fine.
  it.for([
    { seconds: -1, got: "-1" },
    { seconds: Number.NaN, got: "NaN" },
    { seconds: Number.POSITIVE_INFINITY, got: "Infinity" },
    { seconds: "30", got: 'the string "30"' },
    { seconds: undefined, got: "a value of type undefined" },
  ])("answers 500 and logs the app's bug for rateLimited($seconds)", async ({ seconds, got }) => {
    const fixture = serverFixture({ files: refusing(() => rateLimited(seconds as number)) });
    const { status, body } = await answer(fixture);
    expect({ status, code: body.error.code, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: `TypeError: rateLimited(seconds) takes a number of seconds of 0 or more, such as 30. It got ${got}.`,
    });
  });

  it.for([
    {
      name: "FILE_TOO_LARGE with 400",
      refusal: new CloudropError("FILE_TOO_LARGE", "Too big for your plan."),
      status: 400,
      error: { code: "FILE_TOO_LARGE", message: "Too big for your plan.", retryable: false },
    },
    // Rebuilt from code, message and retryable: part numbers belong to PARTS_MISSING and never leave with another code.
    {
      name: "QUOTA_EXCEEDED with 403, without the parts it carried",
      refusal: new CloudropError("QUOTA_EXCEEDED", "Your 1 GB is full.", { parts: [1] }),
      status: 403,
      error: { code: "QUOTA_EXCEEDED", message: "Your 1 GB is full.", retryable: false },
    },
    // The code means "try again later", so a hand-built one without `retryable` is still retried (M12-E1).
    {
      name: "RATE_LIMITED built by hand with 429, retryable",
      refusal: new CloudropError("RATE_LIMITED", "Slow down."),
      status: 429,
      error: { code: "RATE_LIMITED", message: "Slow down.", retryable: true },
    },
    // M12-R34: from plain JavaScript. The client reads a body whose retryable is not a boolean as no error body, which
    // would lose the message; only `true` is retryable.
    {
      name: "FORBIDDEN with a retryable of 1, sent as false",
      refusal: new CloudropError("FORBIDDEN", "Upgrade your plan.", { retryable: 1 as never }),
      status: 403,
      error: { code: "FORBIDDEN", message: "Upgrade your plan.", retryable: false },
    },
    {
      name: "SERVER_ERROR with 500, keeping the app's retryable",
      refusal: new CloudropError("SERVER_ERROR", "Uploads are paused.", { retryable: true }),
      status: 500,
      error: { code: "SERVER_ERROR", message: "Uploads are paused.", retryable: true },
    },
  ])("answers a returned $name", async ({ refusal, status, error }) => {
    const fixture = serverFixture({ files: refusing(() => refusal) });
    const answered = await answer(fixture);
    expect({ status: answered.status, body: answered.body, logged: fixture.logger.errors }).toEqual({
      status,
      body: { error },
      logged: [],
    });
  });

  it("answers a code /upload cannot send as the generic 500, without its parts, and logs the allowed codes", async () => {
    const fixture = serverFixture({
      files: refusing(() => new CloudropError("PARTS_MISSING", "x", { parts: [1] })),
    });
    const { status, body } = await answer(fixture);
    expect({ status, body, logged: fixture.logger.errors.map(({ message }) => message) }).toEqual({
      status: 500,
      body: {
        error: {
          code: "SERVER_ERROR",
          message: "The server could not handle the upload. Contact the site owner if this keeps happening.",
          retryable: false,
        },
      },
      logged: [
        "cloudrop: authorize returned PARTS_MISSING, which /upload cannot send. Return one of UNAUTHORIZED, FORBIDDEN, QUOTA_EXCEEDED, RATE_LIMITED, FILE_TOO_LARGE, FILE_TYPE_NOT_ALLOWED, TOO_MANY_FILES, INVALID_METADATA, INVALID_INPUT, SERVER_ERROR.",
      ],
    });
  });

  // Another installed copy of cloudrop has its own class: its errors are not this server's, as for plugins (M10-K5).
  it("answers 500 for a CloudropError from another copy of cloudrop, and logs how to fix it", async () => {
    const foreign = Object.assign(new Error("Slow down."), { name: "CloudropError", code: "RATE_LIMITED" });
    const fixture = serverFixture({ files: refusing(() => foreign) });
    const { status } = await answer(fixture);
    expect({ status, logged: String(fixture.logger.errors[0]?.error) }).toEqual({
      status: 500,
      logged:
        'TypeError: Route "files": authorize returned a CloudropError from another copy of cloudrop than the server uses. Install cloudrop once, so the route and the server share it.',
    });
  });

  it("answers a plugin's rateLimited(5) with 429 and Retry-After: 5, releasing the plugins before it", async () => {
    const released: string[] = [];
    const plugins: CloudropPlugin[] = [
      { id: "quota", server: { onAbort: ({ reason, file }) => void released.push(`${reason} ${file.name}`) } },
      { id: "limits", server: { beforeUpload: () => rateLimited(5) } },
    ];
    const fixture = serverFixture(
      { files: route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }) },
      { plugins },
    );
    const { status, retryAfter, body } = await answer(fixture);
    expect({ status, retryAfter, code: body.error.code, released }).toEqual({
      status: 429,
      retryAfter: "5",
      code: "RATE_LIMITED",
      released: ["rejected me.png"],
    });
  });

  it("answers a plugin's code /upload cannot send as the generic 500 and logs the allowed codes", async () => {
    const plugins: CloudropPlugin[] = [
      { id: "limits", server: { beforeUpload: () => new CloudropError("NOT_FOUND", "No such album.") } },
    ];
    const fixture = serverFixture(
      { files: route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }) },
      { plugins },
    );
    const { status, body } = await answer(fixture);
    expect({ status, code: body.error.code, logged: fixture.logger.errors.map(({ message }) => message) }).toEqual({
      status: 500,
      code: "SERVER_ERROR",
      logged: [
        "cloudrop: a plugin's beforeUpload returned NOT_FOUND, which /upload cannot send. Return one of UNAUTHORIZED, FORBIDDEN, QUOTA_EXCEEDED, RATE_LIMITED, FILE_TOO_LARGE, FILE_TYPE_NOT_ALLOWED, TOO_MANY_FILES, INVALID_METADATA, INVALID_INPUT, SERVER_ERROR.",
      ],
    });
  });
});

// M12-E3: one status per code, and a 503 can make a load balancer eject a healthy app server. Oracle: R2's throttle
// answer (503 SlowDown, spike Q9) and the spec's table.
describe("RATE_LIMITED from storage", () => {
  it("answers a throttled /complete with 429 and the bucket's Retry-After", async () => {
    const fixture = serverFixture({ files: route({ accept: "*/*", maxSize: "1GB", authorize: allowAnyone }) });
    const ticket = await fixture.single("files", png());
    fixture.fake.fetch = async () =>
      new Response("<Error><Code>SlowDown</Code></Error>", { status: 503, headers: { "retry-after": "4" } });
    const response = await fixture.post("complete", { token: ticket.token });
    expect([response.status, response.headers.get("retry-after"), await response.json()]).toEqual([
      429,
      "4",
      {
        error: {
          code: "RATE_LIMITED",
          message: "The storage service is busy. Try again in a moment.",
          retryable: true,
        },
      },
    ]);
  });
});
