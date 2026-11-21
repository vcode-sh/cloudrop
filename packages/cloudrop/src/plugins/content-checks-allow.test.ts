import { describe, expect, it } from "vitest";
import { allowAnyone, route } from "../server/route.ts";
import { type ContentCase, contentOutcome } from "../testing/content-check-fixture.ts";
import { bytes, HTML, PROGRAM } from "../testing/file-samples.ts";
import { serverFixture } from "../testing/server-fixture.ts";
import { contentChecks } from "./content-checks.ts";

/** The kinds refused by default (M10-K3), each with every type it is refused as. */
const KINDS = [
  { kind: "a web page", names: ["text/html", "application/xhtml+xml"] },
  { kind: "an unknown type", names: ["unknown/unknown", "application/unknown"] },
  {
    kind: "a Windows program",
    names: [
      "application/vnd.microsoft.portable-executable",
      "application/x-msdownload",
      "application/x-msdos-program",
      "application/x-dosexec",
      "application/x-ms-dos-executable",
    ],
  },
  { kind: "a Linux program", names: ["application/x-executable", "application/x-elf", "application/x-sharedlib"] },
  { kind: "a macOS program", names: ["application/x-mach-binary", "application/x-mach-o-executable"] },
  { kind: "a Windows installer", names: ["application/x-msi", "application/x-ms-installer"] },
  {
    kind: "JavaScript",
    names: [
      "application/ecmascript",
      "application/javascript",
      "application/x-ecmascript",
      "application/x-javascript",
      "text/ecmascript",
      "text/javascript",
      "text/javascript1.0",
      "text/javascript1.1",
      "text/javascript1.2",
      "text/javascript1.3",
      "text/javascript1.4",
      "text/javascript1.5",
      "text/jscript",
      "text/livescript",
      "text/x-ecmascript",
      "text/x-javascript",
    ],
  },
  {
    kind: "a shell script",
    names: ["text/x-shellscript", "application/x-sh", "application/x-shellscript", "text/x-sh"],
  },
];

/** The kinds of the tickets /upload gives a request with one file per type, or the refusal's message. */
async function tickets(types: readonly string[], allow: string[]): Promise<string[]> {
  const uploads = route({ accept: "*/*", maxSize: "1MB", maxFiles: 20, authorize: allowAnyone });
  const fixture = serverFixture({ uploads }, { plugins: [contentChecks({ allow })] });
  const files = types.map((type, index) => ({ name: `file-${index}`, type, size: 10 }));
  const body = await (await fixture.post("upload", { route: "uploads", files })).json();
  return body.files?.map(({ kind }: { kind: string }) => kind) ?? [body.error.message];
}

describe("contentChecks: allow at /upload covers a kind by any of its names (M11-R134)", () => {
  it.for(KINDS)("$kind, allowed by each of its names, is signed as every one of them", async ({ names }) => {
    const answers = await Promise.all(names.map((name) => tickets(names, [name])));
    expect(answers).toEqual(names.map(() => names.map(() => "single")));
  });

  it("an allowed kind lets no other kind through", async () => {
    expect(await tickets(["application/x-elf"], ["application/x-msdownload"])).toEqual([
      "One of the files was sent as application/x-elf, which this upload does not accept. Pick another file.",
    ]);
  });
});

const passed = { status: 200, error: null, kept: true, aborted: [] };
const XHTML = bytes('<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>');
const SCRIPT = bytes("#!/bin/sh\necho hi\n");
const PYTHON = bytes("#!/usr/bin/env python3\nprint('hi')\n");
const ELF = bytes([0x7f], "ELF", [2, 1, 1, 0]);
const MACH_O = bytes([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]);

/** The kinds the first bytes show, each with the names its detection goes by. */
const DETECTED = [
  { kind: "a web page", body: HTML, names: ["text/html", "application/xhtml+xml"] },
  { kind: "XHTML", body: XHTML, names: ["text/html", "application/xhtml+xml"] },
  { kind: "a Windows program", body: PROGRAM, names: KINDS[2]?.names ?? [] },
  { kind: "a Linux program", body: ELF, names: KINDS[3]?.names ?? [] },
  { kind: "a macOS program", body: MACH_O, names: KINDS[4]?.names ?? [] },
  { kind: "a shell script", body: SCRIPT, names: KINDS[7]?.names ?? [] },
];

describe("contentChecks: allow at /complete covers the content by any of its names (M11-R134)", () => {
  it.for(DETECTED)("$kind, allowed by each of its names, passes sent as every one of them", async ({ body, names }) => {
    const pairs = names.flatMap((allowed) => names.map((sent) => ({ allowed, sent })));
    const outcomes = await Promise.all(
      pairs.map(({ allowed, sent }) =>
        contentOutcome({ accept: "*/*", file: { name: "file", type: sent }, body, options: { allow: [allowed] } }),
      ),
    );
    const refused = pairs.filter((_, index) => outcomes[index]?.status !== 200);
    expect(refused).toEqual([]);
  });

  it.for<{ name: string; input: ContentCase }>([
    {
      // Review finding G5: the detected type, application/xml, had to be allowed too.
      name: "an XML feed sent as an allowed XML type the route does not name",
      input: {
        accept: "*/*",
        file: { name: "a.rss", type: "application/rss+xml" },
        body: bytes("<?xml version='1.0'?><rss/>"),
        options: { allow: ["application/rss+xml"] },
      },
    },
    {
      name: "a Python script sent as an allowed text type",
      input: {
        accept: "text/*",
        file: { name: "a.py", type: "text/x-python" },
        body: PYTHON,
        options: { allow: ["text/x-python"] },
      },
    },
  ])("passes $name", async ({ input }) => {
    expect(await contentOutcome(input)).toEqual(passed);
  });

  it("refuses content of an allowed kind sent as a type of another kind", async () => {
    const outcome = await contentOutcome({
      accept: "*/*",
      file: { name: "file", type: "application/x-elf" },
      body: PROGRAM,
      options: { allow: ["application/x-msdownload", "application/x-elf"] },
    });
    expect(outcome.error).toEqual({
      code: "FILE_TYPE_NOT_ALLOWED",
      message:
        "This file is a program, but it was sent as application/x-elf. Give it the right extension, or pick another file.",
      retryable: false,
      content: {
        declared: "application/x-elf",
        detected: "application/vnd.microsoft.portable-executable",
        reason: "mismatch",
      },
    });
  });
});
