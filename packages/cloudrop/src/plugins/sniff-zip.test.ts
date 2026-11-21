import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bytes, streamedZipEntry, zipEntry } from "../testing/file-samples.ts";
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
