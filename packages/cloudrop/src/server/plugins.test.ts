import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import {
  type BeforeUploadContext,
  type CloudropPlugin,
  runAfterVerify,
  runBeforeUpload,
  runOnAbort,
} from "./plugins.ts";

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
});
