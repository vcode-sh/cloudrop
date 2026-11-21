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

/**
 * The start of a 64-bit Windows program as GNU ld and lld-link lay it out, without MSVC's Rich header: the MS-DOS
 * header (e_lfanew at 0x3C = 0x80), the DOS stub that prints its message, then the PE signature and the AMD64 machine
 * type (Microsoft PE Format).
 */
export const PROGRAM: Uint8Array<ArrayBuffer> = bytes(
  "MZ",
  [0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0],
  new Array(32).fill(0),
  [0x80, 0, 0, 0],
  [0x0e, 0x1f, 0xba, 0x0e, 0, 0xb4, 0x09, 0xcd, 0x21, 0xb8, 0x01, 0x4c, 0xcd, 0x21],
  "This program cannot be run in DOS mode.\r\r\n$",
  new Array(7).fill(0),
  "PE\0\0",
  [0x64, 0x86],
);

/** A ZIP local file header (PKWARE APPNOTE §4.3.7) for an entry stored uncompressed, with its data. */
export function zipEntry(name: string, data: string): Uint8Array<ArrayBuffer> {
  const size = [data.length & 0xff, data.length >> 8, 0, 0];
  const header = [0x50, 0x4b, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...size, ...size];
  return bytes(header, [name.length, 0, 0, 0], name, data);
}
