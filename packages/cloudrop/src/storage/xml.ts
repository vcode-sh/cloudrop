// S3 responses are small, flat XML documents. A tag-based reader covers every response cloudrop parses and keeps the
// package free of an XML dependency.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ESCAPES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Inner XML of every `<tag>…</tag>` element, in document order. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? "");
}

/** Decoded text of the first `<tag>` element, or undefined when absent. */
export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0];
  return block === undefined ? undefined : decodeXml(block.trim());
}

export function stripQuotes(value: string): string {
  return value.replaceAll('"', "");
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ESCAPES[char] ?? char);
}
