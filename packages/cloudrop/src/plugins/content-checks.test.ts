import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import type { CloudropPlugin } from "../server/plugins.ts";
import { allowAnyone, route } from "../server/route.ts";
import { complete } from "../testing/complete-fixture.ts";
import { bytes, HTML, JPEG, PNG, PROGRAM, SVG, TEXT, zipEntry } from "../testing/file-samples.ts";
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

/** A refusal as the client is sent it: `content` says in data what `message` says in English (M11-K1, M11-K2). */
const refused = (message: string, content: { declared: string; detected: string; reason: string }) => ({
  status: 400,
  error: { code: "FILE_TYPE_NOT_ALLOWED", message, retryable: false, content },
  kept: false,
  aborted: ["rejected"],
});
const passed = { status: 200, error: null, kept: true, aborted: [] };
const PE = "application/vnd.microsoft.portable-executable";
/** What a file the browser could not type is signed as. */
const UNTYPED = "application/octet-stream";

describe("contentChecks: the file's content against its declared type and the route's accept", () => {
  it.for([
    {
      name: "a PNG sent as image/png",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: PNG },
      expected: passed,
    },
    {
      name: "an animated PNG sent as image/apng",
      input: { accept: "image/*", file: { name: "a.apng", type: "image/apng" }, body: PNG },
      expected: passed,
    },
    {
      name: "a JPEG sent as image/png",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: JPEG },
      expected: refused(
        "This file is a JPEG image, but it was sent as image/png. Give it the right extension, or pick another file.",
        { declared: "image/png", detected: "image/jpeg", reason: "mismatch" },
      ),
    },
    {
      name: "a web page sent as image/png",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: HTML },
      expected: refused("This file is a web page (HTML), which this upload does not accept. Pick another file.", {
        declared: "image/png",
        detected: "text/html",
        reason: "refused",
      }),
    },
    {
      name: "a Windows program sent as a PDF",
      input: { accept: "*/*", file: { name: "a.pdf", type: "application/pdf" }, body: PROGRAM },
      expected: refused("This file is a program, which this upload does not accept. Pick another file.", {
        declared: "application/pdf",
        detected: PE,
        reason: "refused",
      }),
    },
    {
      name: "a shell script sent as text",
      input: { accept: "*/*", file: { name: "a.txt", type: "text/plain" }, body: bytes("#!/bin/sh\necho hi\n") },
      expected: refused("This file is a script, which this upload does not accept. Pick another file.", {
        declared: "text/plain",
        detected: "text/x-shellscript",
        reason: "refused",
      }),
    },
    {
      // A script is text: once allowed, a "#!" line agrees with any text type it is sent as.
      name: "a Python script on a route that allows scripts",
      input: {
        accept: "text/*",
        file: { name: "a.py", type: "text/x-python" },
        body: bytes("#!/usr/bin/env python3\nprint('hi')\n"),
        options: { allow: ["text/x-shellscript"] },
      },
      expected: passed,
    },
    {
      // The type Linux desktops give a .pl file (freedesktop.org shared-mime-info).
      name: "a Perl script sent as application/x-perl on a route that allows scripts",
      input: {
        accept: "application/x-perl",
        file: { name: "a.pl", type: "application/x-perl" },
        body: bytes("#!/usr/bin/perl\nprint 1;\n"),
        options: { allow: ["text/x-shellscript"] },
      },
      expected: passed,
    },
    {
      name: "an untyped shell script on a route that allows scripts and takes text/x-sh",
      input: {
        accept: ["text/x-sh", "application/octet-stream"],
        file: { name: "run", type: "" },
        body: bytes("#!/bin/sh\necho hi\n"),
        options: { allow: ["text/x-shellscript"] },
      },
      expected: passed,
    },
    {
      // Only the first 4 KiB is read; e_lfanew points past it, at a header the file is long enough to hold.
      name: "a program whose PE header lies past the first 4 KiB, sent as a PDF",
      input: {
        accept: "*/*",
        file: { name: "a.pdf", type: "application/pdf" },
        body: bytes(
          "MZ",
          new Array(58).fill(0),
          [0, 0x10, 0, 0],
          new Array(0x1000 - 64).fill(0),
          "PE\0\0",
          [0x64, 0x86],
        ),
      },
      expected: refused("This file is a program, which this upload does not accept. Pick another file.", {
        declared: "application/pdf",
        detected: PE,
        reason: "refused",
      }),
    },
    {
      // The browser could not type it, so nothing contradicts; the content's own type must be accepted.
      name: "an untyped PNG on a route that accepts only untyped files",
      input: { accept: "application/octet-stream", file: { name: "data", type: "" }, body: PNG },
      expected: refused("This file is a PNG image, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "image/png",
        reason: "not-accepted",
      }),
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
  ])("$name", async ({ input, expected }) => {
    expect(await outcome(input)).toEqual(expected);
  });
});

const OFFICE = "application/vnd.openxmlformats-officedocument";
const WORKBOOK = bytes(zipEntry("[Content_Types].xml", "<Types/>"), zipEntry("xl/workbook.xml", "<w/>"));
const ARCHIVE = zipEntry("notes.txt", "hello");

describe("contentChecks: ZIP-based files", () => {
  it.for([
    {
      name: "a workbook sent as a Word document",
      input: { accept: "*/*", file: { name: "a.docx", type: `${OFFICE}.wordprocessingml.document` }, body: WORKBOOK },
      expected: refused(
        `This file is an Excel workbook, but it was sent as ${OFFICE}.wordprocessingml.document. Give it the right extension, or pick another file.`,
        {
          declared: `${OFFICE}.wordprocessingml.document`,
          detected: `${OFFICE}.spreadsheetml.sheet`,
          reason: "mismatch",
        },
      ),
    },
    {
      // A macro-enabled workbook keeps its parts under xl/ too.
      name: "a workbook sent as macro-enabled",
      input: {
        accept: "*/*",
        file: { name: "a.xlsm", type: "application/vnd.ms-excel.sheet.macroenabled.12" },
        body: WORKBOOK,
      },
      expected: passed,
    },
    {
      // An archive whose entries name no package may be any of the formats built on ZIP.
      name: "a plain archive sent as an Android package",
      input: { accept: "*/*", file: { name: "a.apk", type: "application/vnd.android.package-archive" }, body: ARCHIVE },
      expected: passed,
    },
    {
      name: "a plain archive sent as a 3D model",
      input: { accept: "*/*", file: { name: "a.3mf", type: "model/3mf" }, body: ARCHIVE },
      expected: passed,
    },
    {
      name: "a plain archive sent as an image",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: ARCHIVE },
      expected: refused(
        "This file is a ZIP archive, but it was sent as image/png. Give it the right extension, or pick another file.",
        { declared: "image/png", detected: "application/zip", reason: "mismatch" },
      ),
    },
  ])("$name", async ({ input, expected }) => {
    expect(await outcome(input)).toEqual(expected);
  });
});

describe("contentChecks: XML and SVG by content", () => {
  it.for([
    {
      name: "an SVG sent as a PNG",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: SVG },
      expected: refused("This file is an SVG image, which this upload does not accept. Pick another file.", {
        declared: "image/png",
        detected: "image/svg+xml",
        reason: "refused",
      }),
    },
    {
      name: "an SVG on a route that names image/svg+xml",
      input: { accept: ["image/png", "image/svg+xml"], file: { name: "a.svg", type: "image/svg+xml" }, body: SVG },
      expected: passed,
    },
    {
      name: "an untyped XML document on a route that accepts anything",
      input: { accept: "*/*", file: { name: "data", type: "" }, body: bytes("<?xml version='1.0'?><rss/>") },
      expected: refused("This file is an XML document, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "application/xml",
        reason: "refused",
      }),
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
        { declared: "image/png", detected: "text/html", reason: "mismatch" },
      ),
    },
    {
      name: "allow lets XML through a route that does not name it",
      input: {
        accept: "*/*",
        file: { name: "data", type: "" },
        body: bytes("<?xml version='1.0'?><rss/>"),
        options: { allow: ["application/xml"] },
      },
      expected: passed,
    },
    {
      name: "deny refuses a type the route accepts, by its content",
      input: { accept: "*/*", file: { name: "data", type: "" }, body: PNG, options: { deny: ["image/*"] } },
      expected: refused("This file is a PNG image, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "image/png",
        reason: "refused",
      }),
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

// The bytes show a PNG, but the declared type decides here, so `detected` is left out (M11-K2).
it("judges the declared type at /complete too, for a token signed before the plugin was installed", async () => {
  const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });
  const before = serverFixture({ files });
  const ticket = await before.single("files", { name: "a.html", type: "text/html", size: PNG.length });
  await before.send(ticket.put, PNG);
  // The same bucket and secret, now with contentChecks.
  const after = serverFixture({ files }, { plugins: [contentChecks()] });
  after.fake.fetch = before.fake.fetch;
  expect((await complete(after, ticket.token)).body.error).toEqual({
    code: "FILE_TYPE_NOT_ALLOWED",
    message: "This file was sent as text/html, which this upload does not accept. Pick another file.",
    retryable: false,
    content: { declared: "text/html", reason: "refused" },
  });
  expect(before.fake.keys()).toEqual([]);
});
