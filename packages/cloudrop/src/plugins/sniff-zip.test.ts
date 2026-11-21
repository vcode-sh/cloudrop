import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bytes, streamedZipEntry, zip64Entry, zipEntry } from "../testing/file-samples.ts";
import { sniff } from "./sniff.ts";

const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const POWERPOINT = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** A part as Office writes it: XML, deflated. */
const part = (xml: string) => new Uint8Array(deflateRawSync(bytes(xml)));
const TYPES = part(
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
);
const RELS = part(
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="word/document.xml"/></Relationships>',
);
const PROPS = part(
  '<?xml version="1.0" encoding="UTF-8"?><Properties><Application>Apache POI</Application></Properties>',
);
const BODY = part("<document/>");

const typeOf = (input: Uint8Array) => sniff(input)?.type ?? null;

describe("sniff: Office files from writers that cannot seek back (M11-R132)", () => {
  it.for([
    {
      // Apache POI's ZipPackage.saveImpl writes the content types first, then the relationships, on a
      // ZipArchiveOutputStream over a plain OutputStream, which puts a data descriptor after every deflated entry.
      name: "[Content_Types].xml first, as Apache POI writes a document",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", TYPES),
        streamedZipEntry("_rels/.rels", RELS),
        streamedZipEntry("word/document.xml", BODY),
      ),
      type: WORD,
    },
    {
      name: "_rels/.rels first",
      input: bytes(streamedZipEntry("_rels/.rels", RELS), streamedZipEntry("xl/workbook.xml", BODY)),
      type: EXCEL,
    },
    {
      name: "docProps/ first",
      input: bytes(
        streamedZipEntry("docProps/app.xml", PROPS),
        streamedZipEntry("docProps/core.xml", PROPS),
        streamedZipEntry("ppt/presentation.xml", BODY),
      ),
      type: POWERPOINT,
    },
    {
      // APPNOTE §4.3.9.3: a data descriptor may come without its signature.
      name: "data descriptors without a signature",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", TYPES, { signature: false }),
        streamedZipEntry("xl/workbook.xml", BODY, { signature: false }),
      ),
      type: EXCEL,
    },
    {
      name: "a streamed entry after one whose sizes are in its header",
      input: bytes(
        zipEntry("[Content_Types].xml", "<Types/>"),
        streamedZipEntry("_rels/.rels", RELS),
        streamedZipEntry("word/document.xml", BODY),
      ),
      type: WORD,
    },
  ])("finds the Office folder with $name", ({ input, type }) => {
    expect(typeOf(input)).toBe(type);
  });

  it.for([
    {
      // The bytes of a local file header inside an entry's data are data: no descriptor ends there with the size of
      // what came before.
      name: "an entry whose data holds a local file header for word/",
      input: bytes(
        streamedZipEntry("backup.bin", bytes("x".repeat(40), zipEntry("word/document.xml", "<w/>"))),
        streamedZipEntry("notes.txt", BODY),
      ),
    },
    {
      name: "a data descriptor whose size is not the entry's",
      input: bytes(streamedZipEntry("a.bin", TYPES, { size: 7 }), streamedZipEntry("word/document.xml", BODY)),
    },
    {
      // Only the first 4 KiB is read: an Office folder that starts later is not seen.
      name: "an Office folder past the first 4 KiB",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", bytes(new Array(4096).fill(0x55))),
        streamedZipEntry("word/document.xml", BODY),
      ).subarray(0, 4096),
    },
  ])("reads $name as a ZIP archive", ({ input }) => {
    expect(typeOf(input)).toBe("application/zip");
  });
});

// APPNOTE §4.3.9.2: a data descriptor's sizes are 8 bytes each in ZIP64 format, which "MAY be used regardless of the
// size of a file". Two writers use it for every entry, however small (file-samples.ts, streamedZipEntry).
describe("sniff: Office files whose data descriptors hold 8-byte sizes (M11-R212)", () => {
  it.for([
    {
      name: "a workbook as Apache POI's SXSSFWorkbook writes it",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", TYPES, { zip64: "poi" }),
        streamedZipEntry("_rels/.rels", RELS, { zip64: "poi" }),
        streamedZipEntry("docProps/app.xml", PROPS, { zip64: "poi" }),
        streamedZipEntry("xl/workbook.xml", BODY, { zip64: "poi" }),
      ),
      type: EXCEL,
    },
    {
      name: "a document as Apache Commons Compress writes it with Zip64Mode.Always",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", TYPES, { zip64: "extra" }),
        streamedZipEntry("word/document.xml", BODY, { zip64: "extra" }),
      ),
      type: WORD,
    },
    {
      name: "8-byte sizes without the descriptor's signature",
      input: bytes(
        streamedZipEntry("_rels/.rels", RELS, { zip64: "poi", signature: false }),
        streamedZipEntry("ppt/presentation.xml", BODY, { zip64: "poi", signature: false }),
      ),
      type: POWERPOINT,
    },
    {
      name: "8-byte sizes after an entry with 4-byte ones",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", TYPES),
        streamedZipEntry("_rels/.rels", RELS, { zip64: "poi" }),
        streamedZipEntry("word/document.xml", BODY),
      ),
      type: WORD,
    },
  ])("finds the Office folder in $name", ({ input, type }) => {
    expect(typeOf(input)).toBe(type);
  });

  // The descriptor is the entry's last 24 bytes: signature, crc-32, then the compressed size, whose upper half is
  // bytes 12 to 9 from the end.
  const beyond4GiB = streamedZipEntry("a.bin", TYPES, { zip64: "poi" });
  beyond4GiB[beyond4GiB.length - 12] = 1;
  it.for([
    { name: "is not the entry's", first: streamedZipEntry("a.bin", TYPES, { zip64: "poi", size: TYPES.length + 1 }) },
    { name: "is the entry's in its lower half only", first: beyond4GiB },
  ])("reads an 8-byte descriptor whose size $name as a ZIP archive", ({ first }) => {
    const input = bytes(first, streamedZipEntry("word/document.xml", BODY, { zip64: "poi" }));
    expect(typeOf(input)).toBe("application/zip");
  });
});

// APPNOTE §4.5.3: a writer that can seek back and writes ZIP64 format for every entry leaves FF FF FF FF in the local
// file header's sizes and puts them in the ZIP64 extra field, with no data descriptor to find the next entry by.
describe("sniff: Office files whose sizes are in the ZIP64 extra field (M11-R221)", () => {
  // An extended timestamp (header ID 5455, Info-ZIP's extrafld.txt), which writers put ahead of other fields.
  const timestamp = [0x55, 0x54, 5, 0, 1, 0, 0, 0, 0];
  it.for([
    {
      name: "as Python's zipfile writes it with force_zip64",
      input: bytes(
        zip64Entry("[Content_Types].xml", TYPES),
        zip64Entry("_rels/.rels", RELS),
        zip64Entry("word/document.xml", BODY),
      ),
      type: WORD,
    },
    {
      name: "behind another extra field",
      input: bytes(zip64Entry("docProps/app.xml", PROPS, { before: timestamp }), zip64Entry("xl/workbook.xml", BODY)),
      type: EXCEL,
    },
    {
      name: "after a streamed entry and one with its sizes in the header",
      input: bytes(
        streamedZipEntry("[Content_Types].xml", TYPES),
        zipEntry("a.txt", "a"),
        zip64Entry("_rels/.rels", RELS),
        zip64Entry("ppt/presentation.xml", BODY),
      ),
      type: POWERPOINT,
    },
  ])("finds the Office folder $name", ({ input, type }) => {
    expect(typeOf(input)).toBe(type);
  });

  it.for([
    {
      // The entry is 4 GiB and 12 bytes long: the next one is not where the size's lower half points.
      name: "a size beyond 4 GiB",
      first: zip64Entry("a.bin", RELS, { compressed: [RELS.length, 0, 0, 0, 1, 0, 0, 0] }),
    },
    {
      name: "a size that is not the entry's",
      first: zip64Entry("a.bin", RELS, { compressed: [7, 0, 0, 0, 0, 0, 0, 0] }),
    },
    {
      // FF FF FF FF with no ZIP64 field says nothing about where the entry ends.
      name: "no ZIP64 field",
      first: bytes(zip64Entry("a.bin", RELS).subarray(0, 28), [0, 0], "a.bin", RELS),
    },
  ])("reads an entry with $name as the end of the walk: a ZIP archive", ({ first }) => {
    expect(typeOf(bytes(first, zip64Entry("word/document.xml", BODY)))).toBe("application/zip");
  });
});
