// S3 responses are small, flat XML documents. A tag-based reader covers every response cloudrop parses and keeps the
// package free of an XML dependency.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ESCAPES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (!entity.startsWith("#")) return ENTITIES[entity] ?? "";
    const codePoint = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    // Out-of-range references stay as written: a malformed body must never make a public call throw.
    return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

/**
 * Inner XML of every `<tag>…</tag>` element, in document order. `tag` is an internal constant, never user input, so it
 * is not escaped into the pattern. Self-closing `<tag />` has no content and is skipped. Linear in the document's
 * length, whatever it holds: an opening tag is matched only up to the next `<`, and its end is found by a plain search
 * that stops for good once no closing tag is left (the transport bounds the document, never its shape).
 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const opening = new RegExp(`<${tag}(?:\\s[^<>]*)?(?<!/)>`, "g");
  const closing = `</${tag}>`;
  const blocks: string[] = [];
  while (opening.test(xml)) {
    const end = xml.indexOf(closing, opening.lastIndex);
    if (end < 0) break;
    blocks.push(xml.slice(opening.lastIndex, end));
    opening.lastIndex = end + closing.length;
  }
  return blocks;
}

/**
 * Decoded text of the first `<tag>` element exactly as sent, or undefined when absent. For keys, upload IDs,
 * continuation tokens and prefixes: whitespace at their edges is part of the value ("users/42/a " is its own key).
 */
export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : decodeXml(block);
}

/** Like xmlText, trimmed: for numbers, dates, booleans, codes and ETags, whose edge whitespace means nothing. */
export function xmlValue(xml: string, tag: string): string | undefined {
  return xmlText(xml, tag)?.trim();
}

/** Trimmed text of every `<tag>` element, in document order: for lists of origins, methods and header names. */
export function xmlValues(xml: string, tag: string): string[] {
  return xmlBlocks(xml, tag).map((block) => decodeXml(block).trim());
}

export function stripQuotes(value: string): string {
  return value.replaceAll('"', "");
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ESCAPES[char] ?? char);
}
