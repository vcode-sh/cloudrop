import { describe, expect, it } from "vitest";
import { type ContentCase, contentOutcome } from "../testing/content-check-fixture.ts";
import { bytes, zipEntry } from "../testing/file-samples.ts";

const refused = (message: string, content: { declared: string; detected: string; reason: string }) => ({
  status: 400,
  error: { code: "FILE_TYPE_NOT_ALLOWED", message, retryable: false, content },
  kept: false,
  aborted: ["rejected"],
});
const passed = { status: 200, error: null, kept: true, aborted: [] };
const UNTYPED = "application/octet-stream";

/** An EBML header with this DocType (RFC 8794 §8, §11.2.6): what MediaRecorder writes with "webm". */
const ebml = (docType: string) =>
  bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x80 | (8 + docType.length), 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x80 | docType.length],
    docType,
  );
/** An ISO BMFF FileTypeBox with this major brand, compatible with it and with "isom". */
const ftyp = (major: string) => bytes([0, 0, 0, 24], "ftyp", major, [0, 0, 0, 0], major, "isom");
const WEBM = ebml("webm");
const OGG = bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
const ARCHIVE = zipEntry("notes.txt", "hello");
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A recording sent as `type` to a route that takes audio and denies video: the guide's own example. */
const audioOnly = (name: string, type: string, body: Uint8Array<ArrayBuffer>): ContentCase => ({
  accept: "audio/*",
  file: { name, type },
  body,
  options: { deny: ["video/*"] },
});

describe("contentChecks: a container's bytes do not say audio or video (M11-R133)", () => {
  it.for([
    { name: "a WebM recording, as MediaRecorder sends it", input: audioOnly("a.webm", "audio/webm", WEBM) },
    { name: "an M4A with the major brand mp42", input: audioOnly("a.m4a", "audio/x-m4a", ftyp("mp42")) },
    { name: "an audio MP4 with the major brand isom", input: audioOnly("a.m4a", "audio/mp4", ftyp("isom")) },
    { name: "an audio MP4 with the major brand dash", input: audioOnly("a.m4a", "audio/mp4", ftyp("dash")) },
    { name: "a Matroska recording", input: audioOnly("a.mka", "audio/x-matroska", ebml("matroska")) },
    { name: "a 3GP recording", input: audioOnly("a.3gp", "audio/3gpp", ftyp("3gp4")) },
    // What deny cannot promise: an Ogg file with a video stream starts with the same bytes.
    { name: "an Ogg file", input: audioOnly("a.ogg", "audio/ogg", OGG) },
    {
      name: "an Ogg video on a route that denies audio",
      input: {
        accept: "video/*",
        file: { name: "a.ogv", type: "video/ogg" },
        body: OGG,
        options: { deny: ["audio/*"] },
      },
    },
    {
      name: "an untyped WebM file on a route that takes audio and denies video",
      input: { ...audioOnly("a", "", WEBM), accept: ["audio/webm", UNTYPED] },
    },
  ])("passes $name sent as a type its container can be", async ({ input }) => {
    expect(await contentOutcome(input)).toEqual(passed);
  });

  it.for([
    {
      name: "a WebM file sent as an image is a mismatch",
      input: { accept: "image/*", file: { name: "a.png", type: "image/png" }, body: WEBM },
      expected: refused(
        "This file is a WebM file, but it was sent as image/png. Give it the right extension, or pick another file.",
        { declared: "image/png", detected: "video/webm", reason: "mismatch" },
      ),
    },
    {
      name: "an untyped WebM file is not accepted where no type it can be is",
      input: { accept: ["image/*", UNTYPED], file: { name: "a", type: "" }, body: WEBM },
      expected: refused("This file is a WebM file, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "video/webm",
        reason: "not-accepted",
      }),
    },
    {
      name: "an untyped WebM file is refused when every type it can be is denied",
      input: {
        accept: "*/*",
        file: { name: "a", type: "" },
        body: WEBM,
        options: { deny: ["video/*", "audio/*"] },
      },
      expected: refused("This file is a WebM file, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "video/webm",
        reason: "refused",
      }),
    },
  ])("$name", async ({ input, expected }) => {
    expect(await contentOutcome(input)).toEqual(expected);
  });
});

describe("contentChecks: a ZIP whose entries name no package (M11-R133)", () => {
  it.for([
    {
      // ZIP is what a Word file is: one whose Office folder lies past the bytes read is still the type it was sent as.
      name: "sent as a Word document, on a route that denies ZIP archives",
      input: {
        accept: WORD,
        file: { name: "a.docx", type: WORD },
        body: ARCHIVE,
        options: { deny: ["application/zip"] },
      },
    },
    {
      name: "sent as an OpenDocument text, on a route that denies ZIP archives",
      input: {
        accept: "*/*",
        file: { name: "a.odt", type: "application/vnd.oasis.opendocument.text" },
        body: ARCHIVE,
        options: { deny: ["application/zip"] },
      },
    },
    {
      name: "untyped, on a route that takes Word documents",
      input: { accept: [WORD, UNTYPED], file: { name: "a", type: "" }, body: ARCHIVE },
    },
  ])("passes $name", async ({ input }) => {
    expect(await contentOutcome(input)).toEqual(passed);
  });

  it.for([
    {
      // application/pdf is no package built on ZIP: the archive does not contradict it, and is still an archive.
      name: "sent as a PDF, on a route that denies ZIP archives, is refused",
      input: {
        accept: ["application/pdf", WORD],
        file: { name: "a.pdf", type: "application/pdf" },
        body: ARCHIVE,
        options: { deny: ["application/zip"] },
      },
      expected: refused("This file is a ZIP archive, which this upload does not accept. Pick another file.", {
        declared: "application/pdf",
        detected: "application/zip",
        reason: "refused",
      }),
    },
    {
      name: "untyped, on a route that takes only PDFs, is not accepted",
      input: { accept: ["application/pdf", UNTYPED], file: { name: "a", type: "" }, body: ARCHIVE },
      expected: refused("This file is a ZIP archive, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "application/zip",
        reason: "not-accepted",
      }),
    },
  ])("$name", async ({ input, expected }) => {
    expect(await contentOutcome(input)).toEqual(expected);
  });
});
