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
 * is not escaped into the pattern; response bodies are bounded by the caller. Self-closing `<tag />` has no content and
 * is skipped.
 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? "");
}

/**
 * Decoded text of the first `<tag>` element exactly as sent, or undefined when absent. For keys, upload IDs, ETags,
 * tokens and prefixes: whitespace at their edges is part of the value ("users/42/a " is its own key).
 */
export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : decodeXml(block);
}

/** Like xmlText, trimmed: for numbers, dates, booleans and codes, whose edge whitespace means nothing. */
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
