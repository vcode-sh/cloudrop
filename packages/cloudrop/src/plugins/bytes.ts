// Reading the first bytes of a file: what the sniffer's parts share.

/** What the content of a file shows it to be. */
export interface Sniffed {
  /** The content's MIME type. */
  type: string;
  /** What a person is told the file is, such as "a PNG image". */
  name: string;
  /**
   * The declared types this content agrees with, `type` first: exact types, a prefix such as
   * "application/vnd.oasis.opendocument.*", or a suffix such as "*+xml".
   */
  agrees: readonly string[];
}

export const kind = (type: string, name: string, ...also: string[]): Sniffed => ({
  type,
  name,
  agrees: [type, ...also],
});

/** A pattern of bytes; null matches any byte. */
export type Pattern = readonly (number | null)[];

export const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

export function startsWith(bytes: Uint8Array, pattern: Pattern, at = 0): boolean {
  return (
    at + pattern.length <= bytes.length && pattern.every((byte, index) => byte === null || bytes[at + index] === byte)
  );
}

/** Bytes as text, one character per byte: every signature compared against it is ASCII. */
export const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

export const uint32BE = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;

export const uint16LE = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

export const uint32LE = (bytes: Uint8Array, at: number): number =>
  uint16LE(bytes, at) + uint16LE(bytes, at + 2) * 0x10000;
