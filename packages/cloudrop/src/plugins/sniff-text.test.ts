import { describe, expect, it } from "vitest";
import { bytes } from "../testing/file-samples.ts";
import { sniff } from "./sniff.ts";

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
  ])("detects a web page in $name", ({ input }) => {
    expect(typeOf(input)).toBe("text/html");
  });
});
