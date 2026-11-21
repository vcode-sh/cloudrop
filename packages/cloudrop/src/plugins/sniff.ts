// A file's real type from its first bytes (M10-K1). Every signature names the specification that defines it; where the
// WHATWG MIME Sniffing standard lists one too, a browser recognises the file the same way.

import { ascii, container, kind, type Pattern, type Sniffed, startsWith, uint16LE, uint32LE } from "./bytes.ts";
import { sniffContainer } from "./sniff-containers.ts";
import { hasBom, sniffText } from "./sniff-text.ts";

export type { Sniffed } from "./bytes.ts";

const ANY4 = [null, null, null, null];
const GIF = kind("image/gif", "a GIF image");
export const WINDOWS: Sniffed = kind(
  "application/vnd.microsoft.portable-executable",
  "a program",
  ..."application/x-msdownload application/x-msdos-program application/x-dosexec".split(" "),
  "application/x-ms-dos-executable",
);
export const LINUX: Sniffed = kind(
  "application/x-executable",
  "a program",
  "application/x-elf",
  "application/x-sharedlib",
);
export const MAC: Sniffed = kind("application/x-mach-binary", "a program", "application/x-mach-o-executable");

const OLE: Sniffed = {
  ...container(
    "application/x-ole-storage",
    "an old Office document or a Windows installer",
    "application/x-msi",
    "application/x-ms-installer",
  ),
  loose: ["application/*"],
};

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
  // An OLE compound file (MS-CFB §2.2, header signature): Word, Excel and PowerPoint files before 2007, Outlook
  // messages, and Windows installers (.msi), which the first bytes do not tell apart (M11-R136).
  [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], OLE],
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

/** MPEG audio's other names: shared-mime-info's aliases of audio/mpeg, and Chromium's (net/base/mime_util.cc). */
const MPEG = "audio/mp3 audio/x-mp3 audio/x-mpeg audio/x-mpg audio/mpeg3".split(" ");
const MP3 = kind("audio/mpeg", "an MP3 recording", ...MPEG);
/**
 * An ID3v2 tag fronts MP3 and MP2, AAC (ADTS) and FLAC files alike, and its bytes do not say which. AAC goes by
 * audio/aac (Firefox, shared-mime-info, with the alias audio/x-aac), audio/aacp, and audio/vnd.dlna.adts, the type
 * Windows gives .aac (IANA registration by Microsoft, 2005) and Chromium, which has none of its own for it, passes on.
 */
const ID3 = container(
  "audio/mpeg",
  "a recording with an ID3 tag",
  ...MPEG,
  ..."audio/mp2 audio/x-mp2 audio/flac audio/x-flac audio/aac audio/x-aac audio/aacp audio/vnd.dlna.adts".split(" "),
);

/**
 * An ID3v2 tag, which WHATWG §6.2 reads as MP3. Its header as id3.org's ID3v2.4.0 structure §3.1 detects it: "ID3", a
 * major version (2 to 4 exist) and a revision under FF, flags whose low four bits, undefined in every version, are
 * clear, and a size of four bytes each under 80.
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

/** Layer III bit rates in kbit/s by index, for MPEG-1 and for MPEG-2 and 2.5 (ISO/IEC 11172-3 §2.4.2.3, 13818-3). */
const RATES = [
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
const SAMPLE_RATES = [44100, 48000, 32000];

/**
 * A Layer III frame header at `at`, as WHATWG MIME Sniffing §6.2.3 matches one: FF, the rest of the frame sync, the
 * layer bits 01, a bit rate index other than 15 and a sample rate index other than 3.
 */
function isFrame(bytes: Uint8Array, at: number): boolean {
  const [sync, flags = 0, rates = 0] = bytes.subarray(at, at + 4);
  return at + 4 <= bytes.length && sync === 0xff && (flags & 0xe6) === 0xe2 && rates >> 4 < 15 && (rates & 0x0c) < 12;
}

/**
 * MPEG audio without an ID3 tag, by the standard's "signature for MP3 without ID3" (§6.2.3): a frame header, and a
 * second one where the first frame ends. The frame's length is computed as Firefox's mp3sniff.c computes it, the code
 * the standard's steps were written from: bit rate times 144, or 72 for MPEG-2 and 2.5, over the sample rate, plus the
 * padding bit. Four bytes alone are not enough: FF FF 00 00 reads as a header (M11-R136).
 */
function sniffMp3(bytes: Uint8Array): Sniffed | null {
  if (!isFrame(bytes, 0)) return null;
  const [, flags = 0, rates = 0] = bytes;
  const version = (flags >> 3) & 3;
  // MPEG-2 halves the sample rate and MPEG-2.5 quarters it.
  const hertz = (SAMPLE_RATES[(rates >> 2) & 3] ?? 1) >> ([2, 0, 1, 0][version] ?? 0);
  const length = Math.floor(((RATES[version & 1]?.[rates >> 4] ?? 0) * (version & 1 ? 144000 : 72000)) / hertz);
  return length && isFrame(bytes, length + ((rates >> 1) & 1)) ? MP3 : null;
}

/** The type the first bytes of a file of `size` bytes show, or null when they show none this module knows. */
export function sniff(bytes: Uint8Array, size: number = bytes.length): Sniffed | null {
  for (const [pattern, sniffed] of SIGNATURES) if (startsWith(bytes, pattern)) return sniffed;
  const binary = sniffId3(bytes) ?? sniffWindows(bytes, size) ?? sniffContainer(bytes);
  // FF FE is UTF-16's byte order mark, and text after it can read as an MPEG audio header: text is tried first.
  return binary ?? (hasBom(bytes) ? null : sniffMp3(bytes)) ?? sniffText(bytes);
}
