import { describe, expect, it } from "vitest";
import { bytes, PROGRAM, zipEntry } from "../testing/file-samples.ts";
import { sniff } from "./sniff.ts";

/** A big-endian 32-bit length, as ISO BMFF boxes carry it. */
const u32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/** An ISO BMFF FileTypeBox: size, "ftyp", major brand, minor version 0, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) =>
  bytes(u32(16 + 4 * compatible.length), "ftyp", major, [0, 0, 0, 0], compatible.join(""));

const typeOf = (input: Uint8Array) => sniff(input)?.type ?? null;
const zeros = (count: number) => new Array(count).fill(0);
/** An MPEG-1 Layer III frame header: 128 kbit/s, 44.1 kHz, no padding (ISO/IEC 11172-3 §2.4.2.3). */
const MP3_HEADER = [0xff, 0xfb, 0x90, 0x64];

describe("sniff: binary signatures", () => {
  it.for([
    { name: "PNG", input: bytes([0x89], "PNG\r\n\x1a\n", u32(13), "IHDR"), type: "image/png" },
    { name: "JPEG (JFIF)", input: bytes([0xff, 0xd8, 0xff, 0xe0], [0, 16], "JFIF"), type: "image/jpeg" },
    { name: "GIF87a", input: bytes("GIF87a", [1, 0, 1, 0]), type: "image/gif" },
    { name: "GIF89a", input: bytes("GIF89a", [1, 0, 1, 0]), type: "image/gif" },
    { name: "WebP (lossy)", input: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "), type: "image/webp" },
    { name: "WAV", input: bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "), type: "audio/wav" },
    { name: "PDF", input: bytes("%PDF-1.7\n"), type: "application/pdf" },
    { name: "ZIP", input: zipEntry("notes.txt", "hello"), type: "application/zip" },
    { name: "empty ZIP", input: bytes("PK", [5, 6], new Array(18).fill(0)), type: "application/zip" },
    { name: "Ogg", input: bytes("OggS", [0, 2]), type: "audio/ogg" },
    { name: "FLAC", input: bytes("fLaC", [0, 0, 0, 0x22]), type: "audio/flac" },
    // ID3v2.4 §3.1: version 4, revision 0, no flags, a syncsafe size of 1,071 bytes.
    // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: a frame of 417 bytes (144 x 128000 / 44100), then the next header.
    { name: "MP3 frames", input: bytes(MP3_HEADER, zeros(413), MP3_HEADER), type: "audio/mpeg" },
    // The padding bit adds a byte to the frame.
    { name: "MP3 frames, padded", input: bytes([0xff, 0xfb, 0x92, 0x64], zeros(414), MP3_HEADER), type: "audio/mpeg" },
    // MPEG-2 Layer III, 64 kbit/s, 22.05 kHz: 208 bytes (72 x 64000 / 22050).
    {
      name: "MPEG-2 Layer III frames",
      input: bytes([0xff, 0xf3, 0x80, 0xc4], zeros(204), [0xff, 0xf3, 0x80, 0xc4]),
      type: "audio/mpeg",
    },
    // MS-CFB §2.2: the header signature of a compound file, which old Office documents and installers share.
    {
      name: "an OLE compound file",
      input: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], zeros(16), [0x3e, 0, 3, 0, 0xfe, 0xff, 9, 0]),
      type: "application/x-ole-storage",
    },
    { name: "Linux program", input: bytes([0x7f], "ELF", [2, 1, 1]), type: "application/x-executable" },
    {
      name: "64-bit macOS program",
      input: bytes([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]),
      type: "application/x-mach-binary",
    },
    {
      name: "universal macOS program",
      input: bytes([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]),
      type: "application/x-mach-binary",
    },
  ])("detects $name", ({ input, type }) => {
    expect(typeOf(input)).toBe(type);
  });

  it.for([
    { name: "a PNG signature with its last byte wrong", input: bytes([0x89], "PNG\r\n\x1a\r") },
    { name: "two bytes of a JPEG start", input: bytes([0xff, 0xd8]) },
    { name: "GIF88a, no GIF version", input: bytes("GIF88a") },
    { name: "a RIFF AVI", input: bytes("RIFF", [0x24, 0, 0, 0], "AVI LIST") },
    { name: "an MP3-like header with the reserved bit rate 15", input: bytes([0xff, 0xfb, 0xf0, 0x64]) },
    { name: "the first two bytes of an MP3 frame header alone", input: bytes([0xff, 0xfb]) },
    { name: "an MP3-like header with the reserved sample rate 3", input: bytes([0xff, 0xfb, 0x9c, 0x64]) },
    // WHATWG MIME Sniffing §6.2.3 wants a second header where the first frame ends (M11-R136).
    { name: "one MP3 frame header and no second", input: bytes(MP3_HEADER, zeros(600)) },
    { name: "a second MP3 header one byte late", input: bytes(MP3_HEADER, zeros(414), MP3_HEADER) },
    { name: "four bytes that read as a Layer I header", input: bytes([0xff, 0xff, 0, 0], zeros(600)) },
    { name: "Layer II frames", input: bytes([0xff, 0xfd, 0x90, 0x64], zeros(413), [0xff, 0xfd, 0x90, 0x64]) },
    { name: "an MP3 header with the free bit rate 0", input: bytes([0xff, 0xfb, 0x00, 0x64], MP3_HEADER) },
    { name: "seven bytes of the OLE signature", input: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a], zeros(9)) },
    { name: "an AAC ADTS header (layer 0)", input: bytes([0xff, 0xf1, 0x50, 0x80]) },
    // FF FE is UTF-16LE's byte order mark, and "h" after it would read as a valid MPEG audio header.
    { name: "UTF-16LE text", input: bytes([0xff, 0xfe], "h\0i\0") },
    { name: "an empty file", input: bytes() },
    { name: "plain text", input: bytes("Shopping list:\n- milk\n") },
    { name: "JSON", input: bytes('{"html": "<html>"}') },
  ])("detects nothing in $name", ({ input }) => {
    expect(sniff(input)).toBeNull();
  });
});

const PE = "application/vnd.microsoft.portable-executable";
/** Little-endian 16- and 32-bit fields. */
const u16 = (value: number) => [value & 0xff, value >> 8];
const u32le = (value: number) => [...u16(value & 0xffff), ...u16(value >>> 16)];
/**
 * The 28 bytes of an MS-DOS .EXE header (The MS-DOS Encyclopedia, Article 4) with these three fields; the defaults are
 * a DOS program's: 80 bytes on the last of 2 pages, no relocations, a 512-byte header (0x20 paragraphs).
 */
const dos = ({ lastPage = 0x50, pages = 2, paragraphs = 0x20 } = {}) =>
  bytes("MZ", u16(lastPage), u16(pages), [0, 0], u16(paragraphs), [0x11, 0, 0xff, 0xff, 0, 0, 0xb8, 0], zeros(10));
/**
 * "MZ", every DOS field zero, and e_lfanew = `at`, as a packed program leaves them (Windows' loader reads only those),
 * padded up to `at` or the 4 KiB the check reads.
 */
const packed = (at: number) => bytes("MZ", zeros(58), u32le(at), zeros(Math.min(at, 0x1000) - 64));

describe("sniff: MS-DOS headers and ID3 tags, which text could start like", () => {
  it.for([
    { name: "a Windows program", input: PROGRAM, size: PROGRAM.length, type: PE },
    { name: "a packed Windows program", input: bytes(packed(0x40), "PE\0\0", [0x4c, 0x01]), size: 70, type: PE },
    { name: "a 16-bit Windows program", input: bytes(packed(0x40), "NE", [5, 10]), size: 68, type: PE },
    { name: "an OS/2 program", input: bytes(packed(0x40), "LX", [0, 0]), size: 68, type: PE },
    // Only the first 4 KiB is read: a header further in is taken on the file's size.
    { name: "a program whose header lies past the bytes read", input: packed(0x1000), size: 0x2000, type: PE },
    { name: "a program whose header ends the file", input: packed(0x1000), size: 0x1004, type: PE },
    {
      name: "a program whose header the read cuts off",
      input: bytes(packed(0xffd), "PE\0"),
      size: 0x2000,
      type: PE,
    },
    { name: "an MS-DOS program", input: dos(), size: 28, type: PE },
    { name: "an MS-DOS program whose header fills its one page", input: dos({ pages: 1 }), size: 28, type: PE },
    // ID3v2.4 §3.1: version 4, revision 0, no flags, a syncsafe size of 1,071 bytes.
    { name: "an ID3v2.4 tag", input: bytes("ID3", [4, 0, 0, 0, 0, 0x08, 0x2f]), size: 10, type: "audio/mpeg" },
    // ID3v2.3 §3.1: flag "a", unsynchronisation, is the top bit.
    {
      name: "an unsynchronised ID3v2.3 tag",
      input: bytes("ID3", [3, 0, 0x80, 0, 0, 0x10, 0]),
      size: 10,
      type: "audio/mpeg",
    },
    { name: "an ID3v2.2 tag", input: bytes("ID3", [2, 0, 0x40, 0, 0, 0, 0x7f]), size: 10, type: "audio/mpeg" },
  ])("detects $name", ({ input, size, type }) => {
    expect(sniff(input, size)?.type).toBe(type);
  });

  it.for([
    // Text that starts with a signature's letters: no byte of it can be a header's binary field.
    { name: "a CSV whose first cell is MZ", input: bytes("MZ,Mozambique,Maputo\nZA,South Africa,Pretoria\n") },
    { name: "text that starts with ID3", input: bytes("ID3 tags are the metadata of an MP3 file.\n") },
    { name: "a DOS header with 512 bytes on its last page", input: dos({ lastPage: 512 }) },
    { name: "a DOS header of one paragraph", input: dos({ paragraphs: 1 }) },
    { name: "a DOS header longer than its one page", input: dos({ pages: 1, paragraphs: 0x21 }) },
    { name: "a DOS header cut at 27 bytes", input: dos().subarray(0, 27) },
    { name: "an e_lfanew pointing at no header", input: bytes(packed(0x40), "NOPE") },
    { name: "an e_lfanew past the end of the file", input: packed(0x1000), size: 0x1003 },
    // The header starts inside the bytes read, so those bytes decide.
    {
      name: "an e_lfanew at the last 3 bytes read, pointing at no header",
      input: bytes(packed(0xffd), "xyz"),
      size: 0x2000,
    },
    // 3 GB of log lines whose bytes at 0x3C read as an offset of 175 MB, inside the file.
    {
      name: "a large log that starts with MZ",
      input: bytes("MZ 2026-11-21T06:00:00Z worker-1 started\n".repeat(3)),
      size: 3_000_000_000,
    },
    { name: "an e_lfanew as large as text can spell", input: packed(0x09090909), size: 0x10000000 },
    { name: "an ID3 tag of version 1", input: bytes("ID3", [1, 0, 0, 0, 0, 0, 0]) },
    { name: "an ID3 tag of version 5", input: bytes("ID3", [5, 0, 0, 0, 0, 0, 0]) },
    { name: "an ID3 tag with revision 0xFF", input: bytes("ID3", [4, 0xff, 0, 0, 0, 0, 0]) },
    { name: "an ID3 tag with an undefined flag set", input: bytes("ID3", [4, 0, 0x01, 0, 0, 0, 0]) },
    { name: "an ID3 tag whose size is not syncsafe", input: bytes("ID3", [4, 0, 0, 0, 0, 0x80, 0]) },
    { name: "an ID3 header cut at 9 bytes", input: bytes("ID3", [4, 0, 0, 0, 0, 0]) },
  ])("detects nothing in $name", ({ input, size }: { input: Uint8Array; size?: number }) => {
    expect(sniff(input, size)).toBeNull();
  });
});

describe("sniff: ISO BMFF brands (ISO/IEC 14496-12 FileTypeBox)", () => {
  it.for([
    { name: "AVIF", input: ftyp("avif", "mif1", "miaf"), type: "image/avif" },
    { name: "HEIC from a phone", input: ftyp("heic", "mif1", "heic"), type: "image/heic" },
    { name: "generic HEIF", input: ftyp("mif1", "mif1", "heic"), type: "image/heif" },
    { name: "MP4", input: ftyp("isom", "isom", "iso2", "avc1", "mp41"), type: "video/mp4" },
    { name: "M4A", input: ftyp("M4A ", "M4A ", "mp42", "isom"), type: "audio/mp4" },
    { name: "QuickTime", input: ftyp("qt  ", "qt  "), type: "video/quicktime" },
    // A camera raw file in an ISO BMFF box: its own brand decides, not the generic isom it is compatible with.
    { name: "an unknown major brand", input: ftyp("crx ", "crx ", "isom"), type: null },
  ])("reads $name", ({ input, type }) => {
    expect(typeOf(input)).toBe(type);
  });
});

describe("sniff: Matroska and WebM (RFC 8794 EBML DocType)", () => {
  // EBML header: ID 1A45DFA3, a one-byte size, EBMLVersion 1 (42 86 81 01), then DocType (42 82) with its size.
  const ebml = (docType: string) =>
    bytes(
      [0x1a, 0x45, 0xdf, 0xa3, 0x80 | (8 + docType.length), 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x80 | docType.length],
      docType,
    );

  it.for([
    { docType: "webm", type: "video/webm" },
    { docType: "matroska", type: "video/x-matroska" },
    { docType: "other", type: null },
  ])("reads DocType $docType", ({ docType, type }) => {
    expect(typeOf(ebml(docType))).toBe(type);
  });

  // A DocType is the file's own text: one named like a member every object inherits is no type (M11-R130).
  it.for(["constructor", "toString", "__proto__", "hasOwnProperty"])("reads no type from DocType %s", (docType) => {
    expect(sniff(ebml(docType))).toBeNull();
  });
});

describe("sniff: ZIP-based office formats", () => {
  it.for([
    {
      name: "a Word document",
      input: bytes(zipEntry("[Content_Types].xml", "<Types/>"), zipEntry("word/document.xml", "<w/>")),
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      name: "an Excel workbook",
      input: bytes(zipEntry("[Content_Types].xml", "<Types/>"), zipEntry("xl/workbook.xml", "<w/>")),
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      name: "a PowerPoint presentation",
      input: bytes(zipEntry("_rels/.rels", "<R/>"), zipEntry("ppt/presentation.xml", "<p/>")),
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    {
      name: "an OpenDocument text",
      input: zipEntry("mimetype", "application/vnd.oasis.opendocument.text"),
      type: "application/vnd.oasis.opendocument.text",
    },
    { name: "an EPUB", input: zipEntry("mimetype", "application/epub+zip"), type: "application/epub+zip" },
    // The mimetype entry is the archive's own text: one naming another kind of type is not taken.
    { name: "a mimetype entry naming HTML", input: zipEntry("mimetype", "text/html"), type: "application/zip" },
  ])("identifies $name", ({ input, type }) => {
    expect(typeOf(input)).toBe(type);
  });
});

describe("sniff: text (WHATWG MIME Sniffing §7.1)", () => {
  it.for([
    { name: "a doctype", input: "<!DOCTYPE html><title>x</title>", type: "text/html" },
    { name: "a tag after whitespace", input: " \t\r\n<HTML>", type: "text/html" },
    { name: "a script tag", input: "<script>alert(1)</script>", type: "text/html" },
    { name: "a one-letter tag", input: "<b>bold</b>", type: "text/html" },
    { name: "a comment", input: "<!-- page -->", type: "text/html" },
    { name: "a tag closed by a slash", input: "<br/>", type: "text/html" },
    { name: "a UTF-8 BOM before the tag", input: "\xef\xbb\xbf<html>", type: "text/html" },
    { name: "UTF-16LE with a BOM", input: "\xff\xfe<\0h\0t\0m\0l\0>\0", type: "text/html" },
    { name: "UTF-16BE with a BOM", input: "\xfe\xff\0<\0s\0c\0r\0i\0p\0t\0>", type: "text/html" },
    { name: "XHTML", input: '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml">', type: "text/html" },
    { name: "an XHTML root after an XML declaration", input: "<?xml version='1.0'?><html>", type: "text/html" },
    // In a declared XML document, a root named like an HTML tag is the app's own element.
    { name: "an XML table", input: "<?xml version='1.0'?><table><row/></table>", type: "application/xml" },
    { name: "a script after a comment with no space", input: "<!--x--><script>alert(1)</script>", type: "text/html" },
    {
      // Namespaces are not read: a character reference can spell one, so any XML a route names may carry scripts.
      name: "XML with an XHTML element in a namespace",
      input: '<?xml version="1.0"?><feed xmlns:h="http://www.w3.org/1999/xhtml"><h:script/>',
      type: "application/xml",
    },
    {
      name: "SVG after a generator comment",
      input: "<!-- Generator: Adobe Illustrator -->\n<svg>",
      type: "image/svg+xml",
    },
    {
      name: "SVG with an XHTML foreignObject",
      input: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">',
      type: "image/svg+xml",
    },
    { name: "SVG", input: '<svg xmlns="http://www.w3.org/2000/svg">', type: "image/svg+xml" },
    {
      name: "SVG after a declaration, a comment and a doctype",
      input: '<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg>',
      type: "image/svg+xml",
    },
    { name: "SVG with a prefix", input: '<s:svg xmlns:s="http://www.w3.org/2000/svg">', type: "image/svg+xml" },
    { name: "an XML document", input: '<?xml version="1.0"?><note>hi</note>', type: "application/xml" },
    { name: "a shell script", input: "#!/bin/sh\nrm -rf /tmp/x\n", type: "text/x-shellscript" },
    // Linux's binfmt_script skips blanks between "#!" and the interpreter's path.
    { name: "a script with a space after #!", input: "#! /usr/bin/env python3\n", type: "text/x-shellscript" },
  ])("detects $name", ({ input, type }) => {
    expect(typeOf(bytes(input))).toBe(type);
  });

  it.for([
    { name: "a tag that is not on the list", input: "<abbr>HTML</abbr>" },
    { name: "a less-than sign in prose", input: "<3 from home" },
    { name: "a tag after other text", input: "Notes: <script>alert(1)</script>" },
    { name: "markup in a CSV", input: "id,body\n1,<b>hi</b>\n" },
    { name: "XML without a declaration", input: "<note>hi</note>" },
    { name: "a prefixed root named like an HTML tag", input: '<x:p xmlns:x="urn:a"/>' },
    { name: "prose that opens with #!", input: "#!important: water the plants\n" },
  ])("detects nothing in $name", ({ input }) => {
    expect(sniff(bytes(input))).toBeNull();
  });
});
