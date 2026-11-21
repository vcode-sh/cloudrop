import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SingleTicket } from "../protocol/types.ts";
import { MiB } from "../rules.ts";
import { serverFixture, tokenPayload } from "../testing/server-fixture.ts";
import { albumSchema, NOW, png, upload } from "../testing/upload-fixture.ts";
import { allowAnyone, forbidden, route, unauthorized } from "./route.ts";

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
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized() or forbidden().',
    },
    // A Next.js habit: a 401 Response is an object, so a typeof check alone would sign for it.
    {
      name: "a Response",
      auth: new Response(null, { status: 401 }),
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized() or forbidden().',
    },
    {
      name: "an Error",
      auth: new Error("Not signed in"),
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized() or forbidden().',
    },
    // A refusal brand on a class instance is neither a refusal nor a user.
    {
      name: "a branded class instance",
      auth: Object.assign(new (class Denied {})(), { [Symbol.for("cloudrop.unauthorized")]: true, message: "No." }),
      log: 'TypeError: Route "files": authorize must return a plain object, unauthorized() or forbidden().',
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
