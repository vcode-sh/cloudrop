// A file's real type from its first bytes (M10-K1). Every signature names the specification that defines it; where the
// WHATWG MIME Sniffing standard lists one too, a browser recognises the file the same way.

import { ascii, container, kind, type Pattern, type Sniffed, startsWith, uint16LE, uint32LE } from "./bytes.ts";
import { sniffContainer } from "./sniff-containers.ts";
import { hasBom, sniffText } from "./sniff-text.ts";

export type { Sniffed } from "./bytes.ts";

const ANY4 = [null, null, null, null];
const GIF = kind("image/gif", "a GIF image");
const PROGRAM = [
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/x-ms-dos-executable",
];
const WINDOWS = kind("application/vnd.microsoft.portable-executable", "a program", ...PROGRAM);
const LINUX = kind("application/x-executable", "a program", "application/x-elf", "application/x-sharedlib");
const MAC = kind("application/x-mach-binary", "a program", "application/x-mach-o-executable");

const SIGNATURES: readonly (readonly [Pattern, Sniffed])[] = [
  // PNG: W3C PNG Specification (Third Edition) §5.2, PNG signature; WHATWG MIME Sniffing §6.1. An animated PNG has the
  // same signature and its own type, image/apng (IANA registration of 2022-11-21, for PNG Third Edition).
  [[0x89, ...ascii("PNG\r\n\x1a\n")], kind("image/png", "a PNG image", "image/apng")],
  // JPEG: ITU-T T.81 Annex B.1.1.3, the SOI marker (FF D8) and the next marker's FF; WHATWG §6.1.
  [[0xff, 0xd8, 0xff], kind("image/jpeg", "a JPEG image", "image/pjpeg")],
  // GIF: the GIF89a specification §17, Header; WHATWG §6.1.
  [ascii("GIF87a"), GIF],
  [ascii("GIF89a"), GIF],
  // RIFF containers: WebP (RFC 9649 §2.5; WHATWG §6.1) and WAVE (WHATWG §6.2).
  [[...ascii("RIFF"), ...ANY4, ...ascii("WEBPVP")], kind("image/webp", "a WebP image")],
  [[...ascii("RIFF"), ...ANY4, ...ascii("WAVE")], kind("audio/wav", "a WAV recording", "audio/x-wav", "audio/wave")],
  // PDF: ISO 32000-2:2020 §7.5.2, File header; WHATWG §7.1.
  [ascii("%PDF-"), kind("application/pdf", "a PDF document")],
  // Ogg: RFC 3533 §6, the capture pattern "OggS" and stream structure version 0; WHATWG §6.2.
  [[...ascii("OggS"), 0], container("audio/ogg", "an Ogg file", "audio/opus", "video/ogg", "application/ogg")],
  // FLAC: RFC 9639 §8, the stream marker "fLaC".
  [ascii("fLaC"), kind("audio/flac", "a FLAC recording", "audio/x-flac")],
  // Linux programs: System V ABI, ELF header, e_ident[EI_MAG0..3].
  [[0x7f, ...ascii("ELF")], LINUX],
  // macOS programs: Apple's <mach-o/loader.h> MH_MAGIC and MH_MAGIC_64 in either byte order, and <mach-o/fat.h>
  // FAT_MAGIC and FAT_MAGIC_64 (CA FE BA BE also opens a Java class file, JVMS §4.1, refused the same way).
  [[0xfe, 0xed, 0xfa, 0xce], MAC],
  [[0xfe, 0xed, 0xfa, 0xcf], MAC],
  [[0xce, 0xfa, 0xed, 0xfe], MAC],
  [[0xcf, 0xfa, 0xed, 0xfe], MAC],
  [[0xca, 0xfe, 0xba, 0xbe], MAC],
  [[0xca, 0xfe, 0xba, 0xbf], MAC],
];

const MP3 = kind("audio/mpeg", "an MP3 recording", "audio/mp3");
const ID3 = kind("audio/mpeg", "an MP3 recording", "audio/mp3", "audio/flac", "audio/x-flac", "audio/aac");

/**
 * An ID3v2 tag, which WHATWG §6.2 reads as MP3; FLAC and AAC files carry one too. Its header as id3.org's ID3v2.4.0
 * structure §3.1 detects it: "ID3", a major version (2 to 4 exist) and a revision under FF, flags whose low four bits,
 * undefined in every version, are clear, and a size of four bytes each under 80.
 */
function sniffId3(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 10 || !startsWith(bytes, ascii("ID3"))) return null;
  const [major = 0, revision = 0, flags = 0, ...size] = bytes.subarray(3, 10);
  const header = major >= 2 && major <= 4 && revision < 0xff && (flags & 0x0f) === 0;
  return header && size.every((byte) => byte < 0x80) ? ID3 : null;
}

/**
 * What e_lfanew leads to: Microsoft PE Format's "PE\0\0", and the "NE" of 16-bit Windows (Microsoft's Executable-File
 * Header Format) and the "LE" and "LX" of OS/2 and Windows drivers (IBM's Linear eXecutable Module Format).
 */
const NEW_HEADERS = [ascii("PE\0\0"), ascii("NE"), ascii("LE"), ascii("LX")];

/**
 * Four bytes of text read as an offset of at least this, 151 MB: past the bytes read, only a smaller e_lfanew is taken.
 */
const TEXT_OFFSET = 0x09090909;

/**
 * Whether e_lfanew, `at`, leads to one of NEW_HEADERS. One the read cuts off counts when the part read matches and the
 * rest fits in the file, at an offset text cannot spell.
 */
function leadsToHeader(bytes: Uint8Array, at: number, size: number): boolean {
  const read = bytes.subarray(at, at + 4);
  return NEW_HEADERS.some((header) => {
    if (startsWith(read, header)) return true;
    const part = header.slice(0, read.length);
    return part.length < header.length && startsWith(read, part) && at < TEXT_OFFSET && at + 4 <= size;
  });
}

/**
 * A program that starts with an MS-DOS header. A Windows program is found as Windows' loader finds it (Microsoft PE
 * Format, "MS-DOS Stub" and "Signature"), by "MZ" and e_lfanew, at 3C, the offset of its own header. Past the bytes
 * read, the offset is taken when the header still fits in the file and the offset is under what text can spell. A DOS
 * program by its header's own fields (The MS-DOS Encyclopedia, Article 4, the
 * .EXE file header): fewer than 512 bytes on the last 512-byte page, and a header of at least two paragraphs (its 28
 * bytes) that fits in the file's pages. Text cannot form one: the last-page count needs a byte 00 or 01.
 */
function sniffWindows(bytes: Uint8Array, size: number): Sniffed | null {
  if (bytes.length < 28 || !startsWith(bytes, ascii("MZ"))) return null;
  if (bytes.length >= 64 && leadsToHeader(bytes, uint32LE(bytes, 0x3c), size)) return WINDOWS;
  const [lastPage, pages, paragraphs] = [uint16LE(bytes, 2), uint16LE(bytes, 4), uint16LE(bytes, 8)];
  return lastPage < 512 && paragraphs >= 2 && paragraphs * 16 <= pages * 512 ? WINDOWS : null;
}

/**
 * An MPEG audio frame header without an ID3 tag, as WHATWG MIME Sniffing §6.2.3 matches one: the 11-bit frame sync, a
 * layer other than the reserved 0, a bit rate index other than the invalid 15, a sample rate index other than the
 * reserved 3 (ISO/IEC 11172-3 §2.4.2.3).
 */
function sniffMp3(bytes: Uint8Array): Sniffed | null {
  // The header is four bytes (§2.4.1.3); WHATWG reads none from fewer.
  const [sync, flags = 0, rates = 0] = bytes;
  const header = bytes.length >= 4 && sync === 0xff && (flags & 0xe0) === 0xe0 && (flags & 0x06) !== 0;
  return header && rates >> 4 !== 15 && ((rates >> 2) & 0x03) !== 3 ? MP3 : null;
}

/** The type the first bytes of a file of `size` bytes show, or null when they show none this module knows. */
export function sniff(bytes: Uint8Array, size: number = bytes.length): Sniffed | null {
  for (const [pattern, sniffed] of SIGNATURES) if (startsWith(bytes, pattern)) return sniffed;
  const binary = sniffId3(bytes) ?? sniffWindows(bytes, size) ?? sniffContainer(bytes);
  // FF FE is UTF-16's byte order mark, and text after it can read as an MPEG audio header: text is tried first.
  return binary ?? (hasBom(bytes) ? null : sniffMp3(bytes)) ?? sniffText(bytes);
}
