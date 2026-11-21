// The first bytes of real file formats, for the content checks' tests. Each sample carries the signature its format's
// specification puts at the start of a file, and nothing that decides more than that. It builds inputs only; every
// expected type stays in the tests.

/** Bytes from strings (one byte per character, as written) and byte lists, in order. */
export function bytes(...parts: (string | Iterable<number>)[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : [...part])),
  );
}

/** A PNG signature and the start of its IHDR chunk. */
export const PNG: Uint8Array<ArrayBuffer> = bytes([0x89], "PNG\r\n\x1a\n", [0, 0, 0, 13], "IHDR", [0, 0, 0, 1]);
/** A JPEG start of image and a JFIF APP0 marker. */
export const JPEG: Uint8Array<ArrayBuffer> = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF\0");
export const HTML: Uint8Array<ArrayBuffer> = bytes("<!DOCTYPE html><script>alert(1)</script>");
export const SVG: Uint8Array<ArrayBuffer> = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
export const TEXT: Uint8Array<ArrayBuffer> = bytes("hello");

/** A ZIP local file header (PKWARE APPNOTE §4.3.7) for an entry stored uncompressed, with its data. */
export function zipEntry(name: string, data: string): Uint8Array<ArrayBuffer> {
  const size = [data.length & 0xff, data.length >> 8, 0, 0];
  const header = [0x50, 0x4b, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...size, ...size];
  return bytes(header, [name.length, 0, 0, 0], name, data);
}
