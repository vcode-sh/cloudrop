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
 * A script is text in any language, so once a route allows scripts, its "#!" line agrees with every text type, and with
 * the types freedesktop.org's shared-mime-info gives shell, Perl, Ruby and PHP scripts.
 */
export const SCRIPT: Sniffed = kind(
  "text/x-shellscript",
  "a script",
  ..."text/x-sh text/* application/x-sh application/x-shellscript".split(" "),
  ..."application/x-perl application/x-ruby application/x-php".split(" "),
);

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
 * What may come before an XML document's root element (XML 1.0 §2.8): whitespace, declarations, comments, a doctype.
 * No two neighbouring parts of the doctype can match the same character, so a doctype that never ends is read once:
 * blanks before its ">" belong to the name part, and only an internal subset is followed by blanks of its own
 * (M11-R211).
 */
const PROLOG_ITEM = /[\t\n\f\r ]+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^[>]*(?:\[[\s\S]*?\]\s*)?>/iy;
/**
 * An element's start tag: its name, with its namespace prefix when it has one, is captured. The name ends where XML
 * 1.0 §3.1 and an HTML parser end it, at whitespace, "/" or ">": the standard's two tag-terminating bytes and the
 * rest of its whitespace bytes. "<a,b>" and "<a@b.com>" are not tags (M11-R131).
 */
const START_TAG = /<((?:[\w.-]+:)?[A-Za-z_][\w.-]*)(?=[\t\n\f\r />])/y;
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

/** The name of the document's root element in lower case, or null when the prolog runs past what was read. */
function rootElement(text: string): string | null {
  let at = 0;
  for (;;) {
    PROLOG_ITEM.lastIndex = at;
    if (!PROLOG_ITEM.exec(text)) break;
    at = PROLOG_ITEM.lastIndex;
  }
  START_TAG.lastIndex = at;
  return START_TAG.exec(text)?.[1]?.toLowerCase() ?? null;
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
  // The root element decides first: an SVG may open with a comment, which alone reads as the start of a web page.
  const root = rootElement(text) ?? "";
  if (root.split(":").at(-1) === "svg") return SVG;
  // WHATWG MIME Sniffing §7.1: "<?xml" is XML.
  const xml = text.startsWith("<?xml");
  if (root === "html" || (!xml && HTML_ROOTS.has(root)) || HTML_START.test(text)) return HTML;
  return xml ? XML : null;
}
