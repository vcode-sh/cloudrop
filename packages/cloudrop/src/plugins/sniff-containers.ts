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

/** EBML DocType values: WebM (webmproject.org container guidelines) and Matroska (RFC 9559 §4.2). */
const DOC_TYPES: Readonly<Record<string, Sniffed>> = {
  webm: kind("video/webm", "a WebM video", "audio/webm"),
  matroska: kind("video/x-matroska", "a Matroska video", "audio/x-matroska", "video/matroska", "audio/matroska"),
};

/**
 * An EBML header (ID 1A 45 DF A3, RFC 8794 §8) and its DocType element (ID 42 82, §11.2.6) with a one-byte size, found
 * the way WHATWG MIME Sniffing §6.2.2 looks for "webm": by scanning the header's first bytes.
 */
function sniffEbml(bytes: Uint8Array): Sniffed | null {
  if (!startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  for (let at = 4; at + 3 < Math.min(bytes.length, 64); at++) {
    const size = bytes[at + 2] ?? 0;
    if (bytes[at] === 0x42 && bytes[at + 1] === 0x82 && size & 0x80) {
      return DOC_TYPES[latin1(bytes, at + 3, at + 3 + (size & 0x7f))] ?? null;
    }
  }
  return null;
}

const LOCAL_FILE = ascii("PK\x03\x04");
const OFFICE = "application/vnd.openxmlformats-officedocument.";
/** Every ZIP-based type a plain archive may have been declared as. */
const ZIP = kind(
  "application/zip",
  "a ZIP archive",
  "application/x-zip-compressed",
  "application/java-archive",
  "*+zip",
  `${OFFICE}*`,
  "application/vnd.oasis.opendocument.*",
);
/**
 * Office Open XML keeps its main part in a folder of its own (ECMA-376 Part 1, §11.3.10 word/document.xml, §12.3.23
 * xl/workbook.xml, §13.3.6 ppt/presentation.xml, the names Office writes).
 */
const OFFICE_FOLDERS: readonly [string, Sniffed][] = [
  ["word/", kind(`${OFFICE}wordprocessingml.document`, "a Word document", "application/zip")],
  ["xl/", kind(`${OFFICE}spreadsheetml.sheet`, "an Excel workbook", "application/zip")],
  ["ppt/", kind(`${OFFICE}presentationml.presentation`, "a PowerPoint presentation", "application/zip")],
];
/** OpenDocument (ODF 1.3 Part 2 §3.3) and EPUB (OCF 3.3 §4.2.1) open with a stored "mimetype" entry naming the type. */
const PACKAGE_TYPE = /^application\/(?:vnd\.oasis\.opendocument\.[a-z.-]{1,64}|epub\+zip)$/;

/** What one entry shows of its package: the type a first "mimetype" entry stores, or an office folder. */
function entryType(name: string, stored: () => string, first: boolean): Sniffed | null {
  const type = first && name === "mimetype" ? stored() : "";
  if (PACKAGE_TYPE.test(type)) {
    return kind(type, type === "application/epub+zip" ? "an EPUB book" : "an OpenDocument file", "application/zip");
  }
  return OFFICE_FOLDERS.find(([folder]) => name.startsWith(folder))?.[1] ?? null;
}

/** The type of a ZIP archive's package, from the entries whose local headers lie in `bytes`. */
function packageType(bytes: Uint8Array): Sniffed | null {
  let at = 0;
  // A local file header (PKWARE APPNOTE 6.3.10 §4.3.7) at a time, while their sizes say where the next one starts.
  while (startsWith(bytes, LOCAL_FILE, at) && at + 30 <= bytes.length) {
    const compressedSize = uint32LE(bytes, at + 18);
    const nameEnd = at + 30 + uint16LE(bytes, at + 26);
    const data = nameEnd + uint16LE(bytes, at + 28);
    const stored = () => latin1(bytes, data, data + compressedSize);
    const found = entryType(latin1(bytes, at + 30, nameEnd), stored, at === 0);
    if (found) return found;
    // Bit 3: the sizes follow the data, so the next header cannot be found from here.
    if (uint16LE(bytes, at + 6) & 0x08) return null;
    at = data + compressedSize;
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
