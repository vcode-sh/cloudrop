import { describe, expect, it } from "vitest";
import { type ContentCase, contentOutcome } from "../testing/content-check-fixture.ts";
import { bytes, zipEntry } from "../testing/file-samples.ts";

const refused = (message: string, content: { declared: string; detected: string; reason: string; kind?: string }) => ({
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
    // shared-mime-info's types for .m4b and .opus, which a Linux desktop sends: audio/x-m4b under either kind of
    // brand, and a "+ogg" type for each codec.
    { name: "an audiobook with the major brand M4B", input: audioOnly("a.m4b", "audio/x-m4b", ftyp("M4B ")) },
    { name: "an audiobook with the major brand isom", input: audioOnly("a.m4b", "audio/x-m4b", ftyp("isom")) },
    { name: "an Opus recording", input: audioOnly("a.opus", "audio/x-opus+ogg", OGG) },
    // Apache httpd's mime.types, which mime-db and so most non-browser clients follow, types .f4v so.
    {
      name: "an F4V video",
      input: { accept: "video/*", file: { name: "a.f4v", type: "video/x-f4v" }, body: ftyp("f4v ") },
    },
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
      // Nobody said which of its types an untyped container is, so one denied type refuses it (M11-R136).
      name: "an untyped WebM file is refused on a route that takes audio and denies video",
      input: { ...audioOnly("a", "", WEBM), accept: ["audio/webm", UNTYPED] },
      expected: refused("This file is a WebM file, which this upload does not accept. Pick another file.", {
        declared: UNTYPED,
        detected: "video/webm",
        reason: "refused",
        kind: "denied",
      }),
    },
  ])("$name", async ({ input, expected }) => {
    expect(await contentOutcome(input)).toEqual(expected);
  });
});

/** An ID3v2.4 header (id3.org ID3v2.4.0 structure §3.1) with a tag of 16 bytes. */
const ID3 = bytes("ID3", [4, 0, 0, 0, 0, 0, 16], new Array(16).fill(0));

describe("contentChecks: an ID3 tag fronts MP3, AAC and FLAC files alike (M11-R135)", () => {
  it.for([
    // Windows gives .aac this type (IANA audio/vnd.dlna.adts), and Chromium has no type of its own for the extension.
    { name: "an AAC file from Chrome on Windows", type: "audio/vnd.dlna.adts" },
    { name: "an AAC file from a Linux desktop", type: "audio/x-aac" },
    { name: "an AAC stream", type: "audio/aacp" },
    { name: "an MP3 by shared-mime-info's alias", type: "audio/x-mp3" },
    { name: "an MP3 by Chromium's alias", type: "audio/mpeg3" },
    { name: "an MP2 file", type: "audio/mp2" },
  ])("passes $name sent as $type", async ({ type }) => {
    expect(await contentOutcome({ accept: "audio/*", file: { name: "a", type }, body: ID3 })).toEqual(passed);
  });

  it("passes a tagged FLAC sent as audio/flac on a route that denies MP3", async () => {
    const input = {
      accept: "audio/*",
      file: { name: "a.flac", type: "audio/flac" },
      body: ID3,
      options: { deny: ["audio/mpeg"] },
    };
    expect(await contentOutcome(input)).toEqual(passed);
  });

  it("refuses a tagged file sent as a type no ID3 tag fronts", async () => {
    const input = { accept: "*/*", file: { name: "a.wav", type: "audio/wav" }, body: ID3 };
    expect(await contentOutcome(input)).toEqual(
      refused(
        "This file is a recording with an ID3 tag, but it was sent as audio/wav. Give it the right extension, or pick another file.",
        { declared: "audio/wav", detected: "audio/mpeg", reason: "mismatch" },
      ),
    );
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
        kind: "denied",
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

// Windows registers .zip as application/x-zip-compressed, and Chromium and Firefox ask the system before their own
// table says application/zip (net/base/mime_util.cc, kSecondaryMappings; nsExternalHelperAppService.cpp, extras).
describe("contentChecks: a package in a ZIP sent as the type Windows gives a .zip (M11-R253)", () => {
  it.for([
    // A folder of lecture notes, zipped: the folder's name is an Office application's, the file is an archive.
    { name: "a ZIP whose first entry is ppt/lecture1.txt", body: zipEntry("ppt/lecture1.txt", "notes") },
    { name: "an EPUB book", body: zipEntry("mimetype", "application/epub+zip") },
  ])("passes $name", async ({ body }) => {
    const input = { accept: "*/*", file: { name: "a.zip", type: "application/x-zip-compressed" }, body };
    expect(await contentOutcome(input)).toEqual(passed);
  });
});
