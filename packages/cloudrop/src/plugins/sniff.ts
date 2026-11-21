// A file's real type from its first bytes (M10-K1). Every signature names the specification that defines it; where the
// WHATWG MIME Sniffing standard lists one too, a browser recognises the file the same way.

import { ascii, kind, type Pattern, type Sniffed, startsWith, uint16LE, uint32LE } from "./bytes.ts";
import { sniffContainer } from "./sniff-containers.ts";
import { hasBom, sniffText } from "./sniff-text.ts";

export type { Sniffed } from "./bytes.ts";

const ANY4 = [null, null, null, null];
const GIF = kind("image/gif", "a GIF image");
const PROGRAM = ["application/x-msdownload", "application/x-msdos-program", "application/x-dosexec"];
const WINDOWS = kind("application/vnd.microsoft.portable-executable", "a program", ...PROGRAM);
const LINUX = kind("application/x-executable", "a program", "application/x-elf", "application/x-sharedlib");
const MAC = kind("application/x-mach-binary", "a program", "application/x-mach-o-executable");

const SIGNATURES: readonly (readonly [Pattern, Sniffed])[] = [
  // PNG: W3C PNG Specification (Third Edition) §5.2, PNG signature; WHATWG MIME Sniffing §6.1.
  [[0x89, ...ascii("PNG\r\n\x1a\n")], kind("image/png", "a PNG image")],
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
  [[...ascii("OggS"), 0], kind("audio/ogg", "an Ogg recording", "audio/opus", "video/ogg", "application/ogg")],
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
 * A program that starts with an MS-DOS header. A Windows program is found as Windows' loader finds it (Microsoft PE
 * Format, "MS-DOS Stub" and "Signature"): e_lfanew, at 3C, gives the offset of "PE\0\0". A DOS program, or one whose
 * signature lies past the bytes read, by the header's own fields (The MS-DOS Encyclopedia, Article 4, the .EXE file
 * header): fewer than 512 bytes on the last 512-byte page, at least one page, and a header of at least two paragraphs
 * (its 28 bytes) that fits in those pages. Text cannot form such a header: the last-page count needs a byte 00 or 01.
 */
function sniffWindows(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 28 || !startsWith(bytes, ascii("MZ"))) return null;
  if (bytes.length >= 64 && startsWith(bytes, ascii("PE\0\0"), uint32LE(bytes, 0x3c))) return WINDOWS;
  const [lastPage, pages, paragraphs] = [uint16LE(bytes, 2), uint16LE(bytes, 4), uint16LE(bytes, 8)];
  return lastPage < 512 && pages > 0 && paragraphs >= 2 && paragraphs * 16 <= pages * 512 ? WINDOWS : null;
}

/**
 * An MPEG audio frame header without an ID3 tag, as WHATWG MIME Sniffing §6.2.3 matches one: the 11-bit frame sync, a
 * layer other than the reserved 0, a bit rate index other than the invalid 15, a sample rate index other than the
 * reserved 3 (ISO/IEC 11172-3 §2.4.2.3).
 */
function sniffMp3([sync, flags = 0, rates = 0]: Uint8Array): Sniffed | null {
  const header = sync === 0xff && (flags & 0xe0) === 0xe0 && (flags & 0x06) !== 0;
  return header && rates >> 4 !== 15 && ((rates >> 2) & 0x03) !== 3 ? MP3 : null;
}

/** The type the first bytes of a file show, or null when they show none this module knows. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  for (const [pattern, sniffed] of SIGNATURES) if (startsWith(bytes, pattern)) return sniffed;
  const binary = sniffId3(bytes) ?? sniffWindows(bytes) ?? sniffContainer(bytes);
  // FF FE is UTF-16's byte order mark, and text after it can read as an MPEG audio header: text is tried first.
  return binary ?? (hasBom(bytes) ? null : sniffMp3(bytes)) ?? sniffText(bytes);
}
