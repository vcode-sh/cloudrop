import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import type { CloudropPlugin } from "../server/plugins.ts";
import { allowAnyone, route } from "../server/route.ts";
import { complete } from "../testing/complete-fixture.ts";
import { bytes, HTML, JPEG, PNG, SVG, TEXT } from "../testing/file-samples.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { type ContentCheckOptions, contentChecks } from "./content-checks.ts";

interface Case {
  accept: string | string[];
  file: { name: string; type: string };
  body: Uint8Array<ArrayBuffer>;
  options?: ContentCheckOptions;
}

/** A server with contentChecks on a route that accepts `accept`, holding `body` uploaded as `file`, not completed. */
async function uploaded({ accept, file, body, options }: Case) {
  const aborted: string[] = [];
  const witness: CloudropPlugin = { id: "witness", server: { onAbort: ({ reason }) => void aborted.push(reason) } };
  const files = route({ accept, maxSize: "1MB", authorize: allowAnyone });
  const fixture = serverFixture({ files }, { plugins: [witness, contentChecks(options)] });
  const ticket = await fixture.single("files", { ...file, size: body.length });
  expect((await fixture.send(ticket.put, body)).status).toBe(200);
  return { fixture, ticket, aborted };
}

/** The answer to /complete, whether the bucket kept the object, and the reasons onAbort heard. */
async function outcome(input: Case) {
  const { fixture, ticket, aborted } = await uploaded(input);
  const { status, body: answer } = await complete(fixture, ticket.token);
  const kept = (await fixture.storage.head(ticket.key)).data !== null;
  return { status, error: answer.error ?? null, kept, aborted };
}

const refused = (message: string) => ({
  status: 400,
  error: { code: "FILE_TYPE_NOT_ALLOWED", message, retryable: false },
  kept: false,
  aborted: ["rejected"],
});
const passed = { status: 200, error: null, kept: true, aborted: [] };

describe("contentChecks: the file's content against its declared type and the route's accept", () => {
  it.for([
    {
      name: "a PNG sent as image/png",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: PNG },
      expected: passed,
    },
    {
      name: "a JPEG sent as image/png",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: JPEG },
      expected: refused(
        "This file is a JPEG image, but it was sent as image/png. Give it the right extension, or pick another file.",
      ),
    },
    {
      name: "a web page sent as image/png",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: HTML },
      expected: refused("This file is a web page (HTML), which this upload does not accept. Pick another file."),
    },
    {
      name: "a Windows program sent as a PDF",
      input: { accept: "*/*", file: { name: "a.pdf", type: "application/pdf" }, body: bytes("MZ", [0x90, 0]) },
      expected: refused("This file is a program, which this upload does not accept. Pick another file."),
    },
    {
      name: "a shell script sent as text",
      input: { accept: "*/*", file: { name: "a.txt", type: "text/plain" }, body: bytes("#!/bin/sh\necho hi\n") },
      expected: refused("This file is a script, which this upload does not accept. Pick another file."),
    },
    {
      // The browser could not type it, so nothing contradicts; the content's own type must be accepted.
      name: "an untyped PNG on a route that accepts only untyped files",
      input: { accept: "application/octet-stream", file: { name: "data", type: "" }, body: PNG },
      expected: refused("This file is a PNG image, which this upload does not accept. Pick another file."),
    },
    {
      name: "an untyped PNG on a route that accepts images",
      input: { accept: ["image/png", "application/octet-stream"], file: { name: "data", type: "" }, body: PNG },
      expected: passed,
    },
    {
      // Nothing recognisable: the declared type, which the route accepted at /upload, stands.
      name: "unrecognised text sent as text",
      input: { accept: "text/plain", file: { name: "a.txt", type: "text/plain" }, body: TEXT },
      expected: passed,
    },
    {
      // A recognisable header (ftyp, mif1) whose compatible brands include AVIF agrees with an AVIF type.
      name: "a HEIF image whose brands include AVIF, sent as image/avif",
      input: {
        accept: "image/avif",
        file: { name: "a.avif", type: "image/avif" },
        body: bytes([0, 0, 0, 24], "ftypmif1", [0, 0, 0, 0], "mif1avif"),
      },
      expected: passed,
    },
    {
      name: "a Word document sent as a ZIP-based office type",
      input: {
        accept: "*/*",
        file: { name: "a.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        body: bytes("PK", [3, 4], new Array(26).fill(0)),
      },
      expected: passed,
    },
  ])("$name", async ({ input, expected }) => {
    expect(await outcome(input)).toEqual(expected);
  });
});

describe("contentChecks: types refused by default", () => {
  it.for([
    {
      name: "an SVG on a route that accepts every image",
      input: { accept: "image/*", file: { name: "a.svg", type: "image/svg+xml" }, body: SVG },
      expected: refused("This file is an SVG image, which this upload does not accept. Pick another file."),
    },
    {
      name: "an SVG on a route that names image/svg+xml",
      input: { accept: ["image/png", "image/svg+xml"], file: { name: "a.svg", type: "image/svg+xml" }, body: SVG },
      expected: passed,
    },
    {
      // The declared type decides when the content says nothing: a browser renders it as what it was sent as.
      name: "plain text sent as image/svg+xml on a route that accepts every image",
      input: { accept: "image/*", file: { name: "a.svg", type: "image/svg+xml" }, body: TEXT },
      expected: refused("This file is an SVG image, which this upload does not accept. Pick another file."),
    },
    {
      name: "plain text sent as text/html",
      input: { accept: "*/*", file: { name: "a.html", type: "text/html" }, body: TEXT },
      expected: refused("This file is a web page (HTML), which this upload does not accept. Pick another file."),
    },
    {
      name: "an XML feed on a route that accepts anything",
      input: {
        accept: "*/*",
        file: { name: "a.rss", type: "application/rss+xml" },
        body: bytes("<?xml version='1.0'?><rss/>"),
      },
      expected: refused("This file is an XML document, which this upload does not accept. Pick another file."),
    },
    {
      name: "an XML feed on a route that names its type",
      input: {
        accept: "application/rss+xml",
        file: { name: "a.rss", type: "application/rss+xml" },
        body: bytes("<?xml version='1.0'?><rss/>"),
      },
      expected: passed,
    },
  ])("$name", async ({ input, expected }) => {
    expect(await outcome(input)).toEqual(expected);
  });
});

describe("contentChecks: allow and deny", () => {
  it.for([
    {
      name: "allow lets a web page through a route that accepts it",
      input: {
        accept: "text/html",
        file: { name: "a.html", type: "text/html" },
        body: HTML,
        options: { allow: ["text/html"] },
      },
      expected: passed,
    },
    {
      name: "allow never lets through content that contradicts its declared type",
      input: {
        accept: "image/*",
        file: { name: "a.png", type: "image/png" },
        body: HTML,
        options: { allow: ["text/html"] },
      },
      expected: refused(
        "This file is a web page (HTML), but it was sent as image/png. Give it the right extension, or pick another file.",
      ),
    },
    {
      name: "deny refuses a type the route accepts, by its content",
      input: { accept: "*/*", file: { name: "data", type: "" }, body: PNG, options: { deny: ["image/*"] } },
      expected: refused("This file is a PNG image, which this upload does not accept. Pick another file."),
    },
    {
      name: "deny wins over allow",
      input: {
        accept: "text/html",
        file: { name: "a.html", type: "text/html" },
        body: HTML,
        options: { allow: ["text/html"], deny: ["text/*"] },
      },
      expected: refused("This file is a web page (HTML), which this upload does not accept. Pick another file."),
    },
  ])("$name", async ({ input, expected }) => {
    expect(await outcome(input)).toEqual(expected);
  });

  it.for([
    { name: "a type in capitals", options: { allow: ["Text/HTML"] } },
    { name: "a type with parameters", options: { deny: ["text/html; charset=utf-8"] } },
    { name: "a list that is a string", options: { deny: "text/html" as unknown as string[] } },
  ])("refuses $name at construction", ({ options }) => {
    expect(() => contentChecks(options)).toThrow(
      new CloudropError(
        "INVALID_CONFIG",
        'contentChecks: allow and deny take lists of MIME types or wildcards, in lower case, such as ["text/html"] or ["image/*"].',
      ),
    );
  });
});

describe("contentChecks: reading the bucket", () => {
  /** The Range header of each GET the server sends from now on. */
  function recordRanges(fixture: Awaited<ReturnType<typeof uploaded>>["fixture"]): (string | null)[] {
    const ranges: (string | null)[] = [];
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) => {
      if ((init?.method ?? "GET") === "GET") ranges.push(new Headers(init?.headers).get("range"));
      return fetch(input, init);
    };
    return ranges;
  }

  it.for([
    { name: "the first 4 KiB of a larger file", size: 10_000, ranges: ["bytes=0-4095"] },
    { name: "a file of exactly 4 KiB whole", size: 4096, ranges: ["bytes=0-4095"] },
    { name: "a one-byte file whole", size: 1, ranges: ["bytes=0-0"] },
    // R2 answers any range of an empty object with 416 InvalidRange (measured 2026-11-21).
    { name: "nothing of an empty file", size: 0, ranges: [] },
  ])("reads $name", async ({ size, ranges }) => {
    const { fixture, ticket } = await uploaded({
      accept: "*/*",
      file: { name: "a.txt", type: "text/plain" },
      body: new Uint8Array(size).fill(0x41),
    });
    const sent = recordRanges(fixture);
    expect((await complete(fixture, ticket.token)).status).toBe(200);
    expect(sent).toEqual(ranges);
  });

  it("keeps the object and asks the client to retry when the bucket cannot be read", async () => {
    const { fixture, ticket } = await uploaded({
      accept: "*/*",
      file: { name: "a.txt", type: "text/plain" },
      body: TEXT,
    });
    const { fetch } = fixture.fake;
    fixture.fake.fetch = (input, init) =>
      (init?.method ?? "GET") === "GET" ? Promise.reject(new TypeError("network down")) : fetch(input, init);
    expect((await complete(fixture, ticket.token)).body.error).toEqual({
      code: "SERVER_ERROR",
      message: "The file was uploaded, but the server could not finish processing it. Try again in a moment.",
      retryable: true,
    });
    expect((await fixture.storage.head(ticket.key)).data?.size).toBe(5);
    fixture.fake.fetch = fetch;
    expect((await complete(fixture, ticket.token)).status).toBe(200);
  });
});
