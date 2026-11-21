// Formats whose type is written inside a container's header, not in fixed bytes: ISO BMFF brands (MP4, MOV, AVIF,
// HEIC), the EBML DocType (WebM, Matroska) and the entries of a ZIP archive (office documents, EPUB) (M10-K1).

import { ascii, kind, latin1, type Sniffed, startsWith, uint16LE, uint32BE, uint32LE } from "./bytes.ts";

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
    kind("video/mp4", "an MP4 video", "audio/mp4", "audio/x-m4a", "video/x-m4v"),
    ...["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "mp41", "mp42", "avc1", "dash"],
    ...["M4V ", "f4v "],
  ),
  ...brands(kind("audio/mp4", "an MP4 recording", "audio/x-m4a"), "M4A ", "M4B ", "M4P "),
  ...brands(kind("video/quicktime", "a QuickTime video"), "qt  "),
  ...brands(kind("video/3gpp", "a 3GP video", "audio/3gpp"), "3gp4", "3gp5", "3gp6", "3gp7", "3ge6", "3gg6"),
  ...brands(kind("video/3gpp2", "a 3GP video", "audio/3gpp2"), "3g2a", "3g2b", "3g2c"),
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
  ["webm", kind("video/webm", "a WebM video", "audio/webm")],
  ["matroska", kind("video/x-matroska", "a Matroska video", "audio/x-matroska", "video/matroska", "audio/matroska")],
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
 * A ZIP whose entries do not name its package agrees with any application or model type: ZIP is the container of APK,
 * JAR, Visio, 3MF, macro-enabled Office and many more (M10-K1).
 */
const ZIP = kind("application/zip", "a ZIP archive", "application/*", "model/*");
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

/** The entries whose local file headers (PKWARE APPNOTE 6.3.10 §4.3.7) lie in `bytes`, while sizes lead to the next. */
function* zipEntries(bytes: Uint8Array): Generator<{ name: string; stored: string }> {
  let at = 0;
  while (startsWith(bytes, LOCAL_FILE, at) && at + 30 <= bytes.length) {
    const size = uint32LE(bytes, at + 18);
    const nameEnd = at + 30 + uint16LE(bytes, at + 26);
    const data = nameEnd + uint16LE(bytes, at + 28);
    yield { name: latin1(bytes, at + 30, nameEnd), stored: latin1(bytes, data, data + size) };
    // Bit 3: the sizes follow the data, so the next header cannot be found from here.
    if (uint16LE(bytes, at + 6) & 0x08) return;
    at = data + size;
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
