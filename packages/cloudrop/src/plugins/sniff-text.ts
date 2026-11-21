// Text a browser runs as a page or an image with scripts: HTML, XHTML, SVG and XML, and a script's "#!" line
// (M10-K1). Only the start of the text decides, as in a browser's own sniffing; an XML document is read on to its root
// element, which decides what a browser renders it as.

import { ascii, kind, type Sniffed, startsWith } from "./bytes.ts";

export const HTML: Sniffed = kind("text/html", "a web page (HTML)", "application/xhtml+xml");
const SVG = kind("image/svg+xml", "an SVG image");
const XML = kind("application/xml", "an XML document", "text/xml", "*+xml");
const SCRIPT = kind("text/x-shellscript", "a script", "application/x-sh", "application/x-shellscript", "text/x-sh");

/**
 * WHATWG MIME Sniffing §7.1, the rules for identifying an unknown MIME type: these tags, in any case, after whitespace,
 * end in a space or ">". A "/" and any other whitespace end them here too: a browser's parser reads those the same.
 */
const HTML_START = /^<(?:!doctype html|html|head|script|iframe|h1|div|font|table|a|style|title|b|body|br|p|!--)[\s/>]/i;
/**
 * The same tags as the unprefixed root element of a document without an XML declaration, after comments or a doctype:
 * a browser that renders it as HTML finds them there. In a declared XML document they are the app's own elements.
 */
const HTML_ROOTS: ReadonlySet<string> = new Set(
  "html head script iframe h1 div font table a style title b body br p".split(" "),
);
/** What may come before an XML document's root element (XML 1.0 §2.8): whitespace, declarations, comments, a doctype. */
const PROLOG_ITEM = /\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^[>]*(?:\[[\s\S]*?\])?\s*>/iy;
/** An element's start tag: its name, with its namespace prefix when it has one, is captured. */
const START_TAG = /<((?:[\w.-]+:)?[A-Za-z_][\w.-]*)/y;

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

export function sniffText(bytes: Uint8Array): Sniffed | null {
  // The kernel runs a file that starts with "#!" through the interpreter named after it (execve(2)).
  if (startsWith(bytes, ascii("#!"))) return SCRIPT;
  const text = decode(bytes).trimStart();
  if (!text.startsWith("<")) return null;
  // The root element decides first: an SVG may open with a comment, which alone reads as the start of a web page.
  const root = rootElement(text) ?? "";
  if (root.split(":").at(-1) === "svg") return SVG;
  // WHATWG MIME Sniffing §7.1: "<?xml" is XML.
  const xml = text.startsWith("<?xml");
  if (root === "html" || (!xml && HTML_ROOTS.has(root)) || HTML_START.test(text)) return HTML;
  return xml ? XML : null;
}
