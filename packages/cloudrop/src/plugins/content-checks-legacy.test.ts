import { describe, expect, it } from "vitest";
import { type ContentCase, contentOutcome } from "../testing/content-check-fixture.ts";
import { bytes } from "../testing/file-samples.ts";

const refused = (message: string, content: { declared: string; detected: string; reason: string }) => ({
  status: 400,
  error: { code: "FILE_TYPE_NOT_ALLOWED", message, retryable: false, content },
  kept: false,
  aborted: ["rejected"],
});
const passed = { status: 200, error: null, kept: true, aborted: [] };
const UNTYPED = "application/octet-stream";
const OLE_TYPE = "application/x-ole-storage";
const EXCEL = "application/vnd.ms-excel";

/** The start of a compound file header (MS-CFB §2.2): the signature, a null CLSID, then the version fields. */
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], new Array(16).fill(0), [0x3e, 0, 3, 0, 0xfe, 0xff]);
const ole = (type: string, options?: ContentCase["options"]): ContentCase => ({
  accept: "*/*",
  file: { name: "file", type },
  body: OLE,
  ...(options && { options }),
});

const OLE_NAME = "an old Office document, an Outlook message or a Windows installer";

describe("contentChecks: OLE compound files, documents, messages and installers alike (M11-R136, M11-R254)", () => {
  it.for([
    { name: "sent as an old Word document", input: ole("application/msword") },
    { name: "sent as an old Excel workbook", input: ole(EXCEL) },
    // Many formats are compound files (Hangul, Outlook messages, CAD): one sent as its own type is not contradicted.
    { name: "sent as a Hangul document", input: ole("application/x-hwp") },
    // An Outlook .msg, an old CAD drawing or a Thumbs.db the browser could not type: it is what it was sent as, as in
    // 0.5.0, since the signature cannot tell it from an installer.
    { name: "untyped", input: ole("") },
    {
      name: "untyped, on a route that names no type it could be",
      input: { ...ole(""), accept: ["image/png", UNTYPED] },
    },
  ])("passes a compound file $name", async ({ input }) => {
    expect(await contentOutcome(input)).toEqual(passed);
  });

  it.for([
    {
      name: "untyped, on a server that denies compound files",
      input: ole("", { deny: [OLE_TYPE] }),
      expected: refused(`This file is ${OLE_NAME}, which this upload does not accept. Pick another file.`, {
        declared: UNTYPED,
        detected: OLE_TYPE,
        reason: "refused",
      }),
    },
    {
      name: "sent as an image",
      input: ole("image/png"),
      expected: refused(
        `This file is ${OLE_NAME}, but it was sent as image/png. Give it the right extension, or pick another file.`,
        { declared: "image/png", detected: OLE_TYPE, reason: "mismatch" },
      ),
    },
  ])("refuses a compound file $name", async ({ input, expected }) => {
    expect(await contentOutcome(input)).toEqual(expected);
  });
});

/** What "Export to Excel" writes in many web applications: an HTML table in a file named .xls. */
const HTML_TABLE = bytes("<table><tr><td>Total</td><td>42</td></tr></table>");
/** Excel 2003 XML (SpreadsheetML), which Excel saves as .xml and applications as .xls. */
const EXCEL_XML = bytes(
  '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"/>',
);
const sheet = (body: Uint8Array<ArrayBuffer>, options?: ContentCase["options"]): ContentCase => ({
  accept: EXCEL,
  file: { name: "report.xls", type: EXCEL },
  body,
  ...(options && { options }),
});

describe("contentChecks: a spreadsheet that is HTML or XML inside (M11-R136)", () => {
  it.for([
    {
      name: "an HTML table sent as an Excel workbook is a web page",
      input: sheet(HTML_TABLE),
      expected: refused("This file is a web page (HTML), which this upload does not accept. Pick another file.", {
        declared: EXCEL,
        detected: "text/html",
        reason: "refused",
      }),
    },
    {
      name: "Excel 2003 XML sent as an Excel workbook is XML",
      input: sheet(EXCEL_XML),
      expected: refused("This file is an XML document, which this upload does not accept. Pick another file.", {
        declared: EXCEL,
        detected: "application/xml",
        reason: "refused",
      }),
    },
    {
      name: "an HTML table passes once the Excel type is allowed",
      input: sheet(HTML_TABLE, { allow: [EXCEL] }),
      expected: passed,
    },
    {
      name: "Excel 2003 XML passes once the Excel type is allowed",
      input: sheet(EXCEL_XML, { allow: [EXCEL] }),
      expected: passed,
    },
  ])("$name", async ({ input, expected }) => {
    expect(await contentOutcome(input)).toEqual(expected);
  });
});
