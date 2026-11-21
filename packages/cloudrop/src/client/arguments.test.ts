// Contract: S17 and M11-R84. Whatever plain JavaScript passes to start(), upload(), resume(), discard() and forget(),
// the call neither throws nor rejects: it answers INVALID_INPUT before any request, and at once, also for a list
// whose length no list has. Oracle: the error code, and a fetch that fails the test when it is called.

import { describe, expect, it } from "vitest";
import { createCloudropClient } from "../client.ts";

const sent: string[] = [];
const client = createCloudropClient({
  persist: false,
  fetch: async (url) => {
    sent.push(url);
    throw new Error("A refused call sent a request.");
  },
});
// The client's types refuse every argument below; plain JavaScript does not.
const start = client.start as (route: unknown, files: unknown, options?: unknown) => ReturnType<typeof client.start>;
const upload = client.upload as (route: unknown, files: unknown, options?: unknown) => Promise<{ error: unknown }>;
const resume = client.resume as (
  upload: unknown,
  file: unknown,
  options?: unknown,
) => { done: Promise<{ error: unknown }> };
const file = () => new File(["hello"], "note.txt", { type: "text/plain" });
const fails = (): never => {
  throw new Error("The caller's own code threw.");
};
const throwing = (field: string) => Object.defineProperty({}, field, { get: fails });
const codeOf = ({ error }: { error: unknown }) => (error as { code?: string } | null)?.code;

const LISTS = [
  { name: "a length of Infinity", files: { length: Number.POSITIVE_INFINITY } },
  { name: "a length of 2 ** 32, above any array's", files: { length: 2 ** 32 } },
  { name: "a length of 2 ** 32 - 1, which a copy would allocate", files: { length: 2 ** 32 - 1 } },
  { name: "a negative length", files: { length: -1 } },
  { name: "a length of NaN", files: { length: Number.NaN } },
  { name: "a fractional length", files: { length: 1.5 } },
  { name: "a list with a hole", files: { length: 3, 0: file(), 2: file() } },
  // biome-ignore lint/suspicious/noSparseArray: the hole is the case.
  { name: "an array with a hole", files: [file(), , file()] },
  { name: "a length whose getter throws", files: throwing("length") },
  { name: "an entry whose getter throws", files: Object.assign(throwing("0"), { length: 1 }) },
  {
    name: "a proxy that throws on every read",
    files: new Proxy({}, { has: fails, get: fails, getPrototypeOf: fails }),
  },
  { name: "a number", files: 7 },
  { name: "a string", files: "note.txt" },
  { name: "null", files: null },
  { name: "nothing", files: undefined },
  { name: "a Blob", files: new Blob(["hello"]) },
];

describe("a list of files that is none", () => {
  it.each(LISTS)("start() answers INVALID_INPUT for $name", async ({ files }) => {
    const job = start("files", files);
    expect([codeOf(await job.done), job.files, sent]).toEqual(["INVALID_INPUT", [], []]);
  });

  it.each(LISTS)("upload() answers INVALID_INPUT for $name", async ({ files }) => {
    expect([codeOf(await upload("files", files)), sent]).toEqual(["INVALID_INPUT", []]);
  });
});

describe("other arguments that are wrong", () => {
  it.each([
    { name: "options whose signal getter throws", args: ["files", file(), throwing("signal")] },
    { name: "options whose metadata getter throws", args: ["files", file(), throwing("metadata")] },
    { name: "options that are a number", args: ["files", file(), 7] },
    { name: "options that are null", args: ["files", file(), null] },
    { name: "a route that is a symbol", args: [Symbol("files"), file()] },
    { name: "a route that is an object", args: [{ toString: () => "files" }, file()] },
  ])("start() and upload() answer INVALID_INPUT for $name", async ({ args }) => {
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
    { name: "null", upload: null },
    { name: "a string", upload: "01HXYZ" },
  ])("resume() and discard() answer INVALID_INPUT for $name", async ({ upload: listed }) => {
    const discard = client.discard as (upload: unknown) => Promise<{ error: unknown }>;
    expect([codeOf(await resume(listed, file()).done), codeOf(await discard(listed)), sent]).toEqual([
      "INVALID_INPUT",
      "INVALID_INPUT",
      [],
    ]);
  });

  it("resume() answers INVALID_INPUT for options whose signal getter throws", async () => {
    expect(codeOf(await resume({ id: "01HXYZ" }, file(), throwing("signal")).done)).toBe("INVALID_INPUT");
  });

  it("forget() answers INVALID_INPUT for options whose getter throws", async () => {
    const forget = client.forget as (options: unknown) => Promise<{ error: unknown }>;
    expect(codeOf(await forget(throwing("all")))).toBe("INVALID_INPUT");
  });
});
