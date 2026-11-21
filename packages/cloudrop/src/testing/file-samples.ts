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

const u32le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

/**
 * A ZIP entry as a writer that cannot seek back writes it (PKWARE APPNOTE §4.4.4, bit 3 of the general purpose flag):
 * crc-32 and sizes are zero in the local file header, and follow the deflated data in a data descriptor (§4.3.9), with
 * the signature most writers put before it unless `signature` is false. `deflated` is the entry's compressed data.
 * `zip64` writes the descriptor's two sizes in 8 bytes each (§4.3.9.2), as one of two writers does, read from their
 * sources on 2026-11-21: "poi" is Apache POI's SXSSFWorkbook since 5.0.0 (Zip64Impl.writeLFH and writeDAT: version 4.5,
 * sizes zero, no extra field); "extra" is Apache Commons Compress with Zip64Mode.Always (ZipArchiveOutputStream: sizes
 * FF FF FF FF in the header and a ZIP64 extra field holding two zero sizes).
 */
export function streamedZipEntry(
  name: string,
  deflated: Uint8Array,
  options: { signature?: boolean; size?: number; zip64?: "poi" | "extra" } = {},
): Uint8Array<ArrayBuffer> {
  const { signature = true, size = deflated.length, zip64 } = options;
  const sizes = new Array(8).fill(zip64 === "extra" ? 0xff : 0);
  const extra = zip64 === "extra" ? [1, 0, 16, 0, ...new Array(16).fill(0)] : [];
  // The version needed, flags (bit 3, and bit 11 for UTF-8 names), method 8 (deflate), time, date, crc-32, both sizes.
  const header = [0x50, 0x4b, 3, 4, zip64 ? 45 : 20, 0, 0x08, zip64 === "poi" ? 0 : 0x08, 8, 0, 0, 0, 0x21, 0];
  const wide = zip64 ? [0, 0, 0, 0] : [];
  const descriptor = [
    ...(signature ? [0x50, 0x4b, 7, 8] : []),
    ...[0xde, 0xad, 0xbe, 0xef],
    ...[...u32le(size), ...wide, ...u32le(size), ...wide],
  ];
  return bytes(header, [0, 0, 0, 0], sizes, [name.length, 0, extra.length, 0], name, extra, deflated, descriptor);
}

/**
 * A deflated ZIP entry as a writer that can seek back writes it in ZIP64 format: no bit 3, both sizes FF FF FF FF in
 * the local file header, and the real ones in 8 bytes each, the uncompressed first, in a ZIP64 extended information
 * extra field, header ID 0001 (PKWARE APPNOTE §4.5.3). These are the bytes Python 3.14's zipfile writes for
 * `ZipFile.open(name, "w", force_zip64=True)` (measured 2026-11-21). `before` are extra fields that come ahead of that
 * one, and `compressed` the size it gives.
 */
export function zip64Entry(
  name: string,
  deflated: Uint8Array,
  options: { before?: number[]; compressed?: number[] } = {},
): Uint8Array<ArrayBuffer> {
  const { before = [], compressed = [...u32le(deflated.length), 0, 0, 0, 0] } = options;
  // An uncompressed size the walk has no use for, then the compressed one.
  const extra = [...before, 1, 0, 16, 0, 0x18, 0, 0, 0, 0, 0, 0, 0, ...compressed];
  const header = [0x50, 0x4b, 3, 4, 45, 0, 0, 0, 8, 0, 0, 0, 0x21, 0, 0xde, 0xad, 0xbe, 0xef];
  return bytes(header, new Array(8).fill(0xff), [name.length, 0, extra.length, 0], name, extra, deflated);
}
