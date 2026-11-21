// Contract: S17 and M11-R84. Whatever plain JavaScript passes to start(), upload(), resume(), discard() and forget(),
// the call neither throws nor rejects: it answers INVALID_INPUT before any request, and at once, also for a list
// whose length no list has. One row per way the arguments are read: upload.test.ts, resume-checks.test.ts and
// discard.test.ts hold each refusal's message. Oracle: the error code, and a fetch that records every request.

import { describe, expect, it } from "vitest";
import { createCloudropClient } from "../client.ts";

/** A client of its own per test, so a request one row sent cannot fail another row. */
function setup() {
  const sent: string[] = [];
  const client = createCloudropClient({
    persist: false,
    fetch: async (url) => {
      sent.push(url);
      throw new Error("A refused call sent a request.");
    },
  });
  // The client's types refuse every argument below; plain JavaScript does not.
  return {
    sent,
    start: client.start as (route: unknown, files: unknown, options?: unknown) => ReturnType<typeof client.start>,
    upload: client.upload as (route: unknown, files: unknown, options?: unknown) => Promise<{ error: unknown }>,
    resume: client.resume as (upload: unknown, file: unknown) => { done: Promise<{ error: unknown }> },
    discard: client.discard as (upload: unknown) => Promise<{ error: unknown }>,
    forget: client.forget as (options: unknown) => Promise<{ error: unknown }>,
  };
}

const file = () => new File(["hello"], "note.txt", { type: "text/plain" });
const fails = (): never => {
  throw new Error("The caller's own code threw.");
};
const throwing = (field: string) => Object.defineProperty({}, field, { get: fails });
const codeOf = ({ error }: { error: unknown }) => (error as { code?: string } | null)?.code;

const LENGTH_GETTER_THROWS = { name: "a length whose getter throws", files: throwing("length") };

describe("a list of files that is none", () => {
  it.each([
    // The first entry is no File: refused there, whatever the length says is still to come.
    { name: "a length of Infinity", files: { length: Number.POSITIVE_INFINITY } },
    { name: "a length of 2 ** 32 - 1, which a copy would allocate", files: { length: 2 ** 32 - 1 } },
    // No entry is read at all.
    { name: "a negative length", files: { length: -1 } },
    { name: "a list with a hole", files: { length: 3, 0: file(), 2: file() } },
    LENGTH_GETTER_THROWS,
    { name: "an entry whose getter throws", files: Object.assign(throwing("0"), { length: 1 }) },
    {
      name: "a proxy that throws on every read",
      files: new Proxy({}, { has: fails, get: fails, getPrototypeOf: fails }),
    },
    { name: "a number", files: 7 },
    { name: "null", files: null },
    { name: "a Blob", files: new Blob(["hello"]) },
  ])("start() answers INVALID_INPUT for $name", async ({ files }) => {
    const { start, sent } = setup();
    const job = start("files", files);
    expect([codeOf(await job.done), job.files, sent]).toEqual(["INVALID_INPUT", [], []]);
  });

  // upload() itself tells a list from one file before it reads either: that read is its own (M11-R84).
  it.each([
    { name: "a list, a length of Infinity", files: { length: Number.POSITIVE_INFINITY } },
    { name: "no list, a number", files: 7 },
    LENGTH_GETTER_THROWS,
  ])("upload() answers INVALID_INPUT for $name", async ({ files }) => {
    const { upload, sent } = setup();
    expect([codeOf(await upload("files", files)), sent]).toEqual(["INVALID_INPUT", []]);
  });
});

describe("other arguments that are wrong", () => {
  it.each([
    { name: "options whose signal getter throws", args: ["files", file(), throwing("signal")] },
    // createCloudropClient(null) is a client; start(route, files, null) is refused.
    { name: "options that are null", args: ["files", file(), null] },
    { name: "a route that is a symbol", args: [Symbol("files"), file()] },
    // Refused, not read as the text it would turn into.
    { name: "a route that is an object", args: [{ toString: () => "files" }, file()] },
  ])("start() and upload() answer INVALID_INPUT for $name", async ({ args }) => {
    const { start, upload, sent } = setup();
    const [route, files, options] = args;
    const started = await start(route, files, options).done;
    expect([codeOf(started), codeOf(await upload(route, files, options)), sent]).toEqual([
      "INVALID_INPUT",
      "INVALID_INPUT",
      [],
    ]);
  });

  it.each([
    { name: "an upload whose id getter throws", upload: throwing("id") },
    // The id alone, where the listed upload belongs.
    { name: "a string", upload: "01HXYZ" },
  ])("resume() and discard() answer INVALID_INPUT for $name", async ({ upload: listed }) => {
    const { resume, discard, sent } = setup();
    expect([codeOf(await resume(listed, file()).done), codeOf(await discard(listed)), sent]).toEqual([
      "INVALID_INPUT",
      "INVALID_INPUT",
      [],
    ]);
  });

  it("forget() answers INVALID_INPUT for options whose getter throws", async () => {
    expect(codeOf(await setup().forget(throwing("all")))).toBe("INVALID_INPUT");
  });
});
