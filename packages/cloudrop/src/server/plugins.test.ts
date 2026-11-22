import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import {
  type BeforeUploadContext,
  type CloudropPlugin,
  runAfterVerify,
  runBeforeUpload,
  runOnAbort,
} from "./plugins.ts";
import { route } from "./route.ts";

/** Records what the runners log. */
function recordingLogger() {
  const errors: { message: string; error: unknown }[] = [];
  return { errors, error: (message: string, error?: unknown) => void errors.push({ message, error }), warn: () => {} };
}

const file = { id: "f1", key: "k/f1.txt", name: "a.txt", size: 1, type: "text/plain" };
const context: BeforeUploadContext = {
  request: new Request("https://app.example.com/api/cloudrop/upload"),
  route: "files",
  accept: ["*/*"],
  files: [file],
  metadata: undefined,
  auth: {},
};

function releasing(id: string, events: string[]): CloudropPlugin {
  return {
    id,
    server: {
      beforeUpload: () => void events.push(`${id} reserved`),
      onAbort: ({ reason }) => void events.push(`${id} released (${reason})`),
    },
  };
}

describe("runBeforeUpload", () => {
  it("releases what earlier plugins reserved when a later one throws, then lets the error through", async () => {
    const events: string[] = [];
    const broken = new Error("limiter unavailable");
    const throwing: CloudropPlugin = {
      id: "limits",
      server: {
        beforeUpload: () => {
          throw broken;
        },
        onAbort: () => void events.push("limits released"),
      },
    };
    const run = runBeforeUpload([releasing("first", events), throwing], context, recordingLogger());
    await expect(run).rejects.toBe(broken);
    // Fail-closed: the upload stops, and the plugin that failed is not asked to release what it never reserved.
    expect(events).toEqual(["first reserved", "first released (failed)"]);
  });

  it("refuses a hook that returns something other than a CloudropError", async () => {
    const sloppy = { id: "sloppy", server: { beforeUpload: () => "no" } } as unknown as CloudropPlugin;
    await expect(runBeforeUpload([sloppy], context, recordingLogger())).rejects.toThrow(
      'Plugin "sloppy": beforeUpload must return nothing or a CloudropError from the same cloudrop the server uses. Install cloudrop once, so the plugin and the server share it.',
    );
  });
});

describe("runOnAbort", () => {
  it("logs a failing onAbort and still runs the plugins after it", async () => {
    const events: string[] = [];
    const failure = new Error("quota store down");
    const failing: CloudropPlugin = {
      id: "failing",
      server: {
        onAbort: () => {
          throw failure;
        },
      },
    };
    const logger = recordingLogger();
    await runOnAbort(
      [failing, releasing("after", events)],
      [{ route: "files", file, metadata: undefined, auth: {}, reason: "aborted" }],
      logger,
    );
    expect({ events, errors: logger.errors }).toEqual({
      events: ["after released (aborted)"],
      errors: [{ message: 'cloudrop: plugin "failing" failed in onAbort for file f1.', error: failure }],
    });
  });
});

describe("runAfterVerify", () => {
  it("stops at the first refusal", async () => {
    const refusal = new CloudropError("VERIFICATION_FAILED", "Refused by the first plugin.");
    const seen: string[] = [];
    const plugins: CloudropPlugin[] = [
      { id: "first", server: { afterVerify: () => refusal } },
      { id: "second", server: { afterVerify: () => void seen.push("second") } },
    ];
    const verified = {
      request: context.request,
      route: "files",
      accept: context.accept,
      file: { ...file, url: null },
      metadata: undefined,
      auth: {},
      storage: {} as never,
    };
    expect([await runAfterVerify(plugins, verified), seen]).toEqual([refusal, []]);
  });

  // Plain JavaScript returns null as easily as nothing, and a throw for it answered 500 on every upload (M11-R45).
  it("reads null from beforeUpload and afterVerify as no refusal, and runs the plugins after it", async () => {
    const seen: string[] = [];
    const plugins: CloudropPlugin[] = [
      { id: "null", server: { beforeUpload: () => null, afterVerify: () => null } },
      {
        id: "after",
        server: { beforeUpload: () => void seen.push("before"), afterVerify: () => void seen.push("after") },
      },
    ];
    const verified = { ...context, file: { ...file, url: null }, storage: {} as never };
    expect([
      await runBeforeUpload(plugins, context, recordingLogger()),
      await runAfterVerify(plugins, verified),
      seen,
    ]).toEqual([undefined, undefined, ["before", "after"]]);
  });
});

const dated = route({ accept: "*/*", maxSize: 1024, authorize: () => ({ userId: "u1", at: new Date(0) }) });
const datedAuth = { userId: "u1", at: "1970-01-01T00:00:00.000Z" };

describe("the auth every hook receives", () => {
  // M12-T5: one type, Jsonified<TAuth>, is true in every hook only if each gets the token's JSON snapshot. beforeUpload
  // and the onAbort it triggers used to see the live object, with a Date where the others saw its ISO string.
  it("is the signed JSON snapshot of authorize's result in beforeUpload, onAbort and afterVerify", async () => {
    const seen: { hook: string; auth: unknown }[] = [];
    const recorder: CloudropPlugin<{ userId: string; at: Date }> = {
      id: "recorder",
      server: {
        beforeUpload: ({ auth }) => void seen.push({ hook: "beforeUpload", auth }),
        afterVerify: ({ auth }) => void seen.push({ hook: "afterVerify", auth }),
        onAbort: ({ auth, reason }) => void seen.push({ hook: `onAbort ${reason}`, auth }),
      },
    };
    const refusing: CloudropPlugin = {
      id: "refusing",
      server: {
        beforeUpload: ({ request }) =>
          request.headers.has("x-refuse") ? new CloudropError("FORBIDDEN", "Refused.") : undefined,
      },
    };
    const files = route({ accept: "*/*", maxSize: 1024, authorize: () => ({ userId: "u1", at: new Date(0) }) });
    const fixture = serverFixture({ files }, { plugins: [recorder, refusing] });
    const refused = await fixture.post("upload", { route: "files", files: [file] }, { "x-refuse": "1" });
    const ticket = await fixture.single("files", file);
    await fixture.send(ticket.put, new TextEncoder().encode("a"));
    const completed = await fixture.post("complete", { token: ticket.token });
    const auth = { userId: "u1", at: "1970-01-01T00:00:00.000Z" };
    expect({ refused: refused.status, completed: completed.status, seen }).toEqual({
      refused: 403,
      completed: 200,
      seen: [
        { hook: "beforeUpload", auth },
        { hook: "onAbort rejected", auth },
        { hook: "beforeUpload", auth },
        { hook: "afterVerify", auth },
      ],
    });
  });

  it("is the snapshot in the onAbort of a file that passed beforeUpload and could not start", async () => {
    const seen: { hook: string; auth: unknown }[] = [];
    const recorder: CloudropPlugin = {
      id: "recorder",
      server: {
        beforeUpload: ({ auth }) => void seen.push({ hook: "beforeUpload", auth }),
        onAbort: ({ auth, reason }) => void seen.push({ hook: `onAbort ${reason}`, auth }),
      },
    };
    const { storage: bucket } = serverFixture({ dated });
    const storage: StorageDriver = {
      ...bucket,
      presignPut: () => {
        throw new Error("driver bug");
      },
    };
    const fixture = serverFixture({ dated }, { storage, plugins: [recorder] });
    await fixture.post("upload", { route: "dated", files: [file] });
    expect(seen).toEqual([
      { hook: "beforeUpload", auth: datedAuth },
      { hook: "onAbort failed", auth: datedAuth },
    ]);
  });

  // The hooks get their own copy: a write to it must not reach the token, which every later step trusts.
  it("is a copy: a beforeUpload that writes to auth leaves what the token signed unchanged", async () => {
    const writer: CloudropPlugin = {
      id: "writer",
      server: { beforeUpload: ({ auth }) => void Object.assign(auth as object, { userId: "mallory", quota: 5 }) },
    };
    const signed = route(
      { accept: "*/*", maxSize: 1024, authorize: () => ({ userId: "u1", at: new Date(0) }) },
      { onComplete: ({ request, file: _file, metadata, ...auth }) => auth },
    );
    const fixture = serverFixture({ signed }, { plugins: [writer] });
    const ticket = await fixture.single("signed", file);
    await fixture.send(ticket.put, new TextEncoder().encode("a"));
    const completed = await fixture.post("complete", { token: ticket.token });
    expect(((await completed.json()) as { data: unknown }).data).toEqual(datedAuth);
  });
});
