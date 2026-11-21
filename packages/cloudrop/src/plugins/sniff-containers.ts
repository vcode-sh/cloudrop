// Formats whose type is written inside a container's header, not in fixed bytes: ISO BMFF brands (MP4, MOV, AVIF,
// HEIC), the EBML DocType (WebM, Matroska) and the entries of a ZIP archive (office documents, EPUB) (M10-K1).

import { ascii, container, kind, latin1, type Sniffed, startsWith, uint16LE, uint32BE, uint32LE } from "./bytes.ts";

const brands = (sniffed: Sniffed, ...names: string[]) => names.map((name) => [name, sniffed] as const);

/**
 * ISO BMFF brands (ISO/IEC 14496-12 §4.3, FileTypeBox; brand list at the MP4 Registration Authority, mp4ra.org): AVIF
 * (AV1 Image File Format §9.1), HEIF and HEIC (ISO/IEC 23008-12 §10 and Annex B), MP4 (ISO/IEC 14496-14), Apple's M4A
 * and QuickTime ("qt  ", QuickTime File Format, File type compatibility atom), 3GPP (3GPP TS 26.244 §5.4).
 */
const BRANDS: ReadonlyMap<string, Sniffed> = new Map([
  ...brands(kind("image/avif", "an AVIF image"), "avif", "avis"),
  ...brands(
    kind("image/heic", "a HEIC image", "image/heif", "image/heic-sequence", "image/heif-sequence"),
    ..."heic heix heim heis hevc hevx hevm hevs".split(" "),
  ),
  ...brands(
    kind("image/heif", "a HEIF image", "image/heic", "image/heif-sequence", "image/heic-sequence"),
    "mif1",
    "msf1",
  ),
  ...brands(
    container("video/mp4", "an MP4 file", "audio/mp4", "audio/x-m4a", "video/x-m4v"),
    ...["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "avc1", "dash"],
    ...["M4V ", "f4v "],
  ),
  ...brands(kind("audio/mp4", "an MP4 recording", "audio/x-m4a"), "M4A ", "M4B ", "M4P "),
  ...brands(kind("video/quicktime", "a QuickTime video"), "qt  "),
  ...brands(container("video/3gpp", "a 3GP file", "audio/3gpp"), "3gp4", "3gp5", "3gp6", "3gp7", "3ge6", "3gg6"),
  ...brands(container("video/3gpp2", "a 3GP file", "audio/3gpp2"), "3g2a", "3g2b", "3g2c"),
]);

/**
 * The major brand decides the type; it must be known, so a file of another kind in the same box (a camera's raw image
 * compatible with "isom") is not taken for a video. Every known compatible brand adds the types it agrees with.
 */
function sniffIsoBmff(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 16 || latin1(bytes, 4, 8) !== "ftyp") return null;
  const major = BRANDS.get(latin1(bytes, 8, 12));
  if (!major) return null;
  const end = Math.min(uint32BE(bytes, 0), bytes.length);
  const agrees = new Set(major.agrees);
  for (let at = 16; at + 4 <= end; at += 4) {
    for (const type of BRANDS.get(latin1(bytes, at, at + 4))?.agrees ?? []) agrees.add(type);
  }
  return { ...major, agrees: [...agrees] };
}

/**
 * EBML DocType values: WebM (webmproject.org container guidelines) and Matroska (RFC 9559 §4.2). A Map, as BRANDS is:
 * the name comes from the file, and a plain object would answer "constructor" with a function (M11-R130).
 */
const DOC_TYPES: ReadonlyMap<string, Sniffed> = new Map([
  ["webm", container("video/webm", "a WebM file", "audio/webm")],
  [
    "matroska",
    container("video/x-matroska", "a Matroska file", "audio/x-matroska", "video/matroska", "audio/matroska"),
  ],
]);

/**
 * An EBML header (ID 1A 45 DF A3, RFC 8794 §8) and its DocType element (ID 42 82, §11.2.6) with a one-byte size, found
 * the way WHATWG MIME Sniffing §6.2.2 looks for "webm": by scanning the header's first bytes.
 */
function sniffEbml(bytes: Uint8Array): Sniffed | null {
  if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  for (let at = 4; at + 3 < Math.min(bytes.length, 64); at++) {
    const size = bytes[at + 2] ?? 0;
    if (bytes[at] === 0x42 && bytes[at + 1] === 0x82 && size & 0x80) {
      return DOC_TYPES.get(latin1(bytes, at + 3, at + 3 + (size & 0x7f))) ?? null;
    }
  }
  return null;
}

const LOCAL_FILE = ascii("PK\x03\x04");
const OFFICE = "application/vnd.openxmlformats-officedocument.";
/**
 * A ZIP whose entries do not name its package. Sent as a type of a format built on ZIP it is that type: Office Open
 * XML and Microsoft's macro-enabled types, OpenDocument, and every "+zip" type (WHATWG MIME Sniffing §4.6, ZIP-based
 * MIME type), EPUB among them. It contradicts no other application or model type either: ZIP is the container of APK,
 * JAR, Visio, 3MF and many more (M10-K1).
 */
const ZIP: Sniffed = {
  ...container(
    "application/zip",
    "a ZIP archive",
    `${OFFICE}*`,
    "application/vnd.ms-*",
    "application/vnd.oasis.opendocument.*",
    "*+zip",
  ),
  loose: ["application/*", "model/*"],
};
/**
 * Office Open XML keeps its main part in a folder of its own (ECMA-376 Part 1, §11.3.10 word/document.xml, §12.3.23
 * xl/workbook.xml, §13.3.6 ppt/presentation.xml, the names Office writes). An application's templates, slide shows and
 * macro-enabled files share its folder, so each agrees with its application's types, Open XML and Microsoft's own.
 */
const office = (family: string, microsoft: string, type: string, name: string) =>
  kind(
    `${OFFICE}${family}.${type}`,
    name,
    `${OFFICE}${family}.*`,
    `application/vnd.ms-${microsoft}*`,
    "application/zip",
  );
const OFFICE_FOLDERS: readonly [string, Sniffed][] = [
  ["word/", office("wordprocessingml", "word", "document", "a Word document")],
  ["xl/", office("spreadsheetml", "excel", "sheet", "an Excel workbook")],
  ["ppt/", office("presentationml", "powerpoint", "presentation", "a PowerPoint presentation")],
];
/** OpenDocument (ODF 1.3 Part 2 §3.3) and EPUB (OCF 3.3 §4.2.1) open with a stored "mimetype" entry naming the type. */
const PACKAGE_TYPE = /^application\/(?:vnd\.oasis\.opendocument\.[a-z.-]{1,64}|epub\+zip)$/;

/**
 * Where the entry after a streamed one starts. Bit 3 of the general purpose flag (PKWARE APPNOTE 6.3.10 §4.4.4) leaves
 * the sizes zero in the local file header and puts them after the data in a data descriptor (§4.3.9), which Java's
 * ZipOutputStream, Apache Commons Compress (so Apache POI) and Node's archiver write for every deflated entry, with a
 * signature the format does not require (§4.3.9.3). Its two sizes take 4 bytes each, or 8 in ZIP64 format (§4.3.9.2),
 * which POI's SXSSFWorkbook writes for every entry without saying so in the header (M11-R212). The next entry is the
 * first local file header behind a descriptor, of either width, signed or not, whose compressed size is the distance
 * from `data`; those bytes anywhere else are the entry's data.
 */
function afterStreamed(bytes: Uint8Array, data: number): number {
  for (let at = data + 12; at + 4 <= bytes.length; at++) {
    if (!startsWith(bytes, LOCAL_FILE, at)) continue;
    for (const width of [4, 8]) {
      // The compressed size stands two sizes before the header, behind the crc-32 and, with a signature, 4 bytes more.
      const size = at - 2 * width;
      const signature = size - 4 - data - uint32LE(bytes, size);
      // Within the bytes read, the upper half of an 8-byte size is zero.
      const upperHalf = width === 8 ? uint32LE(bytes, size + 4) : 0;
      if ((signature === 0 || signature === 4) && upperHalf === 0) return at;
    }
  }
  return bytes.length;
}

/**
 * The compressed size of an entry whose local file header gives `size` and whose extra fields lie from `extra` to
 * `data`. FF FF FF FF sends a reader to the ZIP64 extended information extra field, header ID 0001, which holds the
 * uncompressed size and then the compressed one in 8 bytes each (APPNOTE §4.5.3): a writer that can seek back and
 * writes ZIP64 format for every entry, as Python's zipfile does with force_zip64, has the sizes nowhere else
 * (M11-R221). Without that field the size stays what it was, past any bytes read.
 */
function compressedSize(bytes: Uint8Array, size: number, extra: number, data: number): number {
  if (size !== 0xffffffff) return size;
  for (let field = extra; field + 4 <= data; field += 4 + uint16LE(bytes, field + 2)) {
    if (uint16LE(bytes, field) === 1) return uint32LE(bytes, field + 12) + uint32LE(bytes, field + 16) * 2 ** 32;
  }
  return size;
}

/** The entries whose local file headers (APPNOTE §4.3.7) lie in `bytes`. */
function* zipEntries(bytes: Uint8Array): Generator<{ name: string; stored: string }> {
  let at = 0;
  while (startsWith(bytes, LOCAL_FILE, at) && at + 30 <= bytes.length) {
    const nameEnd = at + 30 + uint16LE(bytes, at + 26);
    const data = nameEnd + uint16LE(bytes, at + 28);
    const size = compressedSize(bytes, uint32LE(bytes, at + 18), nameEnd, data);
    yield { name: latin1(bytes, at + 30, nameEnd), stored: latin1(bytes, data, data + size) };
    at = uint16LE(bytes, at + 6) & 0x08 ? afterStreamed(bytes, data) : data + size;
  }
}

/** The type of a ZIP archive's package: its first entry's stored "mimetype", or an Office folder. */
function packageType(bytes: Uint8Array): Sniffed | null {
  let first = true;
  for (const { name, stored } of zipEntries(bytes)) {
    if (first && name === "mimetype" && PACKAGE_TYPE.test(stored)) {
      return kind(
        stored,
        stored === "application/epub+zip" ? "an EPUB book" : "an OpenDocument file",
        "application/zip",
      );
    }
    first = false;
    const found = OFFICE_FOLDERS.find(([folder]) => name.startsWith(folder));
    if (found) return found[1];
  }
  return null;
}

/** A ZIP archive (APPNOTE §4.3.7 local file header, §4.3.16 end of central directory of an empty one). */
function sniffZip(bytes: Uint8Array): Sniffed | null {
  if (startsWith(bytes, ascii("PK\x05\x06"))) return ZIP;
  return startsWith(bytes, LOCAL_FILE) ? (packageType(bytes) ?? ZIP) : null;
}

export const sniffContainer = (bytes: Uint8Array): Sniffed | null =>
  sniffIsoBmff(bytes) ?? sniffEbml(bytes) ?? sniffZip(bytes);
