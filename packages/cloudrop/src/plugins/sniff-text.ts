// Text a browser runs as a page or an image with scripts: HTML, XHTML, SVG and XML, and a script's "#!" line
// (M10-K1). Only the start of the text decides, as in a browser's own sniffing; an XML document is read on to its root
// element, which decides what a browser renders it as.

import { kind, type Sniffed, startsWith } from "./bytes.ts";

/**
 * Old Office types whose files may be HTML or XML inside: a web application's "Export to Excel" writes an HTML table,
 * and Excel and Word 2003 save XML. Such content is still a web page or XML, refused as one; it does not contradict
 * these types, so `allow` can let it through by them (M11-R136).
 */
const loose = ["application/vnd.ms-excel", "application/msword"];
/** A web page; an HTML application (.hta) is one that Windows runs outside the browser. */
export const HTML: Sniffed = {
  ...kind("text/html", "a web page (HTML)", "application/xhtml+xml", "application/hta"),
  loose,
};
const SVG = kind("image/svg+xml", "an SVG image");
const XML: Sniffed = { ...kind("application/xml", "an XML document", "text/xml", "*+xml"), loose };
/**
 * A script by its "#!" line, under the types freedesktop.org's shared-mime-info gives shell, Perl, Ruby and PHP
 * scripts. A script is text in any language, so once scripts are allowed it contradicts no text type; a text type is
 * still not what it is, and a route that names one does not thereby take an untyped script (M11-R255).
 */
export const SCRIPT: Sniffed = {
  ...kind(
    "text/x-shellscript",
    "a script",
    ..."text/x-sh application/x-sh application/x-shellscript".split(" "),
    ..."application/x-perl application/x-ruby application/x-php".split(" "),
  ),
  loose: ["text/*"],
};

/**
 * WHATWG MIME Sniffing §7.1, the rules for identifying an unknown MIME type (Living Standard, 19 October 2026): the two
 * rows of its table that are not an element. "<!DOCTYPE HTML" in any case, before a tag-terminating byte: a space or
 * ">" (§3). And "<!--": the standard wants a tag-terminating byte after it too, but Chromium (net/base/mime_sniffer.cc,
 * kSniffableTags) and Firefox (network.mimesniff.non_standard_html_comment, on by default) take it before any byte.
 */
const HTML_START = /^<(?:!doctype html[ >]|!--)/i;
/**
 * The table's fifteen elements, and the element that makes a page an HTML application (Microsoft, HTA:APPLICATION
 * element). Each is matched as the unprefixed root element of a document without an XML
 * declaration: at the start, as the standard has it, and after comments or a doctype, where a browser that renders the
 * document as HTML finds it. In a declared XML document they are the app's own elements.
 */
const HTML_ROOTS: ReadonlySet<string> = new Set(
  "html head script iframe h1 div font table a style title b body br p hta:application".split(" "),
);
/**
 * What may come before a document's root element (XML 1.0 §2.8): whitespace, comments, and the opening of a doctype or
 * of a processing instruction, whose ends `doctypeEnd` and `rootElement` find.
 */
const PROLOG_ITEM = /[\t\n\f\r ]+|<!--[\s\S]*?-->|(<!doctype)|<\?/iy;
/**
 * One part of a doctype: a quoted literal (XML 1.0 §2.3), a comment (§2.5) or a processing instruction (§2.6), whose
 * text may hold any character, or one character outside them. One that opens and never closes matches nothing, so the
 * doctype is read once, in time that grows with its length (M11-R211, M11-R220).
 */
const DOCTYPE_PART = /"[^"]*"|'[^']*'|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|[^"'<]|<(?!!--|\?)/y;
/**
 * An element's start tag: its name, with its namespace prefix when it has one, is captured. The name ends where XML
 * 1.0 §3.1 and an HTML parser end it, at whitespace, "/" or ">": the standard's two tag-terminating bytes and the
 * rest of its whitespace bytes. "<a,b>" and "<a@b.com>" are not tags (M11-R131).
 */
const START_TAG = /<((?:[\w.-]+:)?[A-Za-z_][\w.-]*)(?=[\t\n\f\r />])/y;
/** What is left of a prolog the read cut: nothing, a comment, or the first characters of a comment or a tag. */
const CUT = /^(?:<!--|<!-?$|<[\w.:-]*$|$)/;
/** The standard's whitespace bytes (§3), which every row of its table ignores before the pattern. */
const LEADING = /^[\t\n\f\r ]+/;

/** UTF-16 code units from `start`, as WHATWG Encoding's BOM sniff selects them; enough to compare ASCII. */
function utf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const units: number[] = [];
  for (let at = start; at + 1 < bytes.length; at += 2) {
    const [first = 0, second = 0] = [bytes[at], bytes[at + 1]];
    units.push(littleEndian ? first | (second << 8) : (first << 8) | second);
  }
  return String.fromCharCode(...units);
}

/** The text after its byte order mark (WHATWG Encoding §6, BOM sniff); without one, a byte per character. */
function decode(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xfe, 0xff])) return utf16(bytes, 2, false);
  if (startsWith(bytes, [0xff, 0xfe])) return utf16(bytes, 2, true);
  return String.fromCharCode(...bytes.subarray(startsWith(bytes, [0xef, 0xbb, 0xbf]) ? 3 : 0));
}

/**
 * Where the doctype whose "<!DOCTYPE" ends at `at` ends, as an XML parser reads it (XML 1.0 §2.8, doctypedecl and
 * intSubset): at the first ">" that is neither inside its internal subset, the part in brackets, nor inside a quoted
 * literal, a comment or a processing instruction. 0 when it is still open where the text ends.
 */
function doctypeEnd(text: string, at: number): number {
  let subset = false;
  DOCTYPE_PART.lastIndex = at;
  for (let part = DOCTYPE_PART.exec(text); part; part = DOCTYPE_PART.exec(text)) {
    if (part[0] === ">" && !subset) return DOCTYPE_PART.lastIndex;
    subset = part[0] === "[" || (subset && part[0] !== "]");
  }
  return 0;
}

/**
 * Where the prolog item PROLOG_ITEM just matched ends, 0 when it is still open where the text ends. `html` reads it as
 * an HTML parser does: a doctype ends at its first ">", inside quotes too (HTML Standard §13.2.5, the DOCTYPE states),
 * and so does "<?", which opens a bogus comment there (§13.2.5.6, §13.2.5.41).
 */
function itemEnd(text: string, item: RegExpExecArray, html: boolean): number {
  const at = PROLOG_ITEM.lastIndex;
  if (item[1] && !html) return doctypeEnd(text, at);
  if (!item[1] && item[0] !== "<?") return at;
  const close = html ? ">" : "?>";
  const end = text.indexOf(close, at);
  return end < 0 ? 0 : end + close.length;
}

/**
 * The name of the document's root element in lower case, "" when what follows the prolog is not a start tag, and null
 * when the text ends before the root of a document: one that has shown a doctype, and ends in it, in the blanks, the
 * comment or the processing instruction after it, or in the first characters of the root's tag (M11-R220, M11-R258).
 * Text that opens with a processing instruction and shows no doctype is not known to be a document: PHP source opens
 * with "<?php" and need never close it.
 */
function rootElement(text: string, html: boolean): string | null {
  let at = 0;
  let doctype = false;
  for (;;) {
    PROLOG_ITEM.lastIndex = at;
    const item = PROLOG_ITEM.exec(text);
    if (!item) break;
    doctype ||= !!item[1];
    at = itemEnd(text, item, html);
    if (!at) return doctype ? null : "";
  }
  START_TAG.lastIndex = at;
  const root = START_TAG.exec(text)?.[1]?.toLowerCase() ?? "";
  // No tag, and nothing after the prolog but a comment that never ends or the start of one or of a tag's name.
  return doctype && !root && CUT.test(text.slice(at)) ? null : root;
}

/** Whether `bytes` start with a byte order mark: such a file is text, whatever bytes follow. */
export const hasBom = (bytes: Uint8Array): boolean =>
  startsWith(bytes, [0xfe, 0xff]) || startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xef, 0xbb, 0xbf]);

/**
 * A script's first line (execve(2)): "#!", the blanks Linux's binfmt_script skips, and the interpreter's path, which
 * scripts give in full. Prose that opens with "#!", such as "#!important", names no path and is not a script. The
 * line also counts behind a byte order mark or blank lines: execve does not run such a file, but a shell that gets
 * ENOEXEC runs it as a shell script (POSIX.1-2024, Shell Command Language §2.9.1.4), and so does `sh file`.
 */
const SCRIPT_START = /^#![ \t]*\//;

export function sniffText(bytes: Uint8Array): Sniffed | null {
  const text = decode(bytes).replace(LEADING, "");
  if (SCRIPT_START.test(text)) return SCRIPT;
  if (!text.startsWith("<")) return null;
  // WHATWG MIME Sniffing §7.1: "<?xml" is XML.
  const xml = text.startsWith("<?xml");
  const root = rootElement(text, false);
  // A document without an XML declaration is a web page to a browser that gets it as one, and its HTML parser ends a
  // doctype sooner than an XML parser: the root either of them finds decides (M11-R220).
  const roots = xml ? [root] : [root, rootElement(text, true)];
  // The root element decides first: an SVG may open with a comment, which alone reads as the start of a web page.
  if (roots.some((name) => name?.split(":").at(-1) === "svg")) return SVG;
  const page = roots.some((name) => name === "html" || (!xml && HTML_ROOTS.has(name ?? "")));
  if (page || HTML_START.test(text)) return HTML;
  // A prolog still open where the read ends hides the root of a document only an XML parser reads on.
  return xml || root === null ? XML : null;
}
