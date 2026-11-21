import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CloudropError, ok } from "../errors.ts";
import type { AfterVerifyContext } from "../server/plugins.ts";
import { bytes, HTML, JPEG, PNG, PROGRAM, SVG, zip64Entry, zipEntry } from "../testing/file-samples.ts";
import { contentChecks } from "./content-checks.ts";
import { sniff } from "./sniff.ts";

/** How each format the sniffer knows starts: enough of it to reach the code that reads the rest. */
const PREFIXES = [
  bytes([0x89], "PNG\r\n\x1a\n"),
  bytes([0xff, 0xd8, 0xff]),
  bytes("GIF89a"),
  bytes("RIFF", [0, 0, 0, 0], "WEBPVP"),
  bytes("RIFF", [0, 0, 0, 0], "WAVE"),
  bytes("%PDF-"),
  bytes("OggS", [0]),
  bytes("fLaC"),
  bytes([0x7f], "ELF"),
  bytes([0xca, 0xfe, 0xba, 0xbe]),
  bytes("ID3", [4, 0, 0]),
  bytes([0xff, 0xfb]),
  bytes("MZ"),
  bytes("MZ", new Array(58).fill(0), [0x40, 0, 0, 0], "PE"),
  bytes([0, 0, 0, 0x20], "ftyp"),
  bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 0, 0], "mp42"),
  bytes([0xff, 0xff, 0xff, 0xff], "ftypheic"),
  bytes([0x1a, 0x45, 0xdf, 0xa3]),
  bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], "matroska"),
  bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0xff]),
  // DocTypes named like members every object inherits.
  bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x8b], "constructor"),
  bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x89], "__proto__"),
  bytes("PK", [3, 4]),
  bytes("PK", [3, 4, 20, 0, 8, 0, 8, 0], new Array(18).fill(0), [5, 0, 0, 0], "word/"),
  bytes("PK", [3, 4, 20, 0, 0, 0, 0, 0], new Array(10).fill(0xff), [0xff, 0xff, 0xff, 0xff, 8, 0, 0xff, 0xff]),
  // Sizes in a ZIP64 extra field, whose own length and the lengths of the fields before it are the file's to say.
  zip64Entry("a", bytes()),
  zip64Entry("a", bytes(), { before: [0x55, 0x54] }),
  zipEntry("mimetype", "application/vnd.oasis.opendocument."),
  bytes("PK", [5, 6]),
  bytes("PK", [7, 8]),
  bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  bytes("#!"),
  bytes("#! \t/"),
  bytes("\n#!/"),
  bytes([0xef, 0xbb, 0xbf], "#!/"),
  bytes([0xef, 0xbb, 0xbf], "<"),
  bytes([0xff, 0xfe], "<\0"),
  bytes([0xfe, 0xff], "\0<"),
  bytes("<?xml"),
  bytes("<?xml ?><!DOCTYPE x ["),
  // A doctype's parts that may hold "]>" and ">", each left open (M11-R220).
  bytes('<!DOCTYPE x [<!ENTITY a "'),
  bytes("<?xml ?><!DOCTYPE x [<!ENTITY a '"),
  bytes("<!DOCTYPE x [<!--"),
  bytes("<!DOCTYPE x [<?p "),
  bytes('<!DOCTYPE x SYSTEM "'),
  bytes("<!DOCTYPE x []"),
  bytes("<!--"),
  bytes("<!DOCTYPE html"),
  bytes("<!DOCTYPE "),
  bytes("<svg"),
  bytes("<HTA:APPLICATION"),
  bytes(" \t\r\n<a"),
  bytes("<"),
  bytes(),
];
const SAMPLES = [PNG, JPEG, HTML, SVG, PROGRAM, zipEntry("[Content_Types].xml", "<Types/>"), ...PREFIXES];
const DECLARED = [
  "application/octet-stream",
  "image/png",
  "text/plain",
  "audio/webm",
  "application/zip",
  "application/xml",
  "application/vnd.ms-excel",
  "constructor/__proto__",
];

/** A repeatable stream of bytes (Numerical Recipes' linear congruential generator), so a failure names its input. */
function randomBytes(seed: number) {
  let state = seed >>> 0;
  return (count: number) =>
    Array.from({ length: count }, () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 24;
    });
}

/** Each prefix before random bytes, cut at every length up to 64, and each sample with one byte changed. */
function inputs(): Uint8Array<ArrayBuffer>[] {
  const next = randomBytes(20261121);
  const made: Uint8Array<ArrayBuffer>[] = [];
  for (const prefix of PREFIXES) {
    for (let length = 0; length <= 64; length++) {
      for (let round = 0; round < 7; round++) made.push(bytes(prefix, next(64)).subarray(0, length));
    }
  }
  for (const sample of SAMPLES) {
    for (let at = 0; at < sample.length; at++) {
      const mutated = bytes(sample, next(8));
      mutated[at] = next(1)[0] ?? 0;
      made.push(mutated);
    }
  }
  return made;
}

const hex = (input: Uint8Array) => Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("");

const { afterVerify } = contentChecks({ deny: ["video/*"] }).server ?? {};

/** The hook's answer for `body` sent as `type`, or the text of what it threw. */
async function verdict(body: Uint8Array<ArrayBuffer>, type: string): Promise<string> {
  const context = {
    file: { id: "f", key: "k", name: "n", size: body.length, type, url: null },
    accept: ["*/*"],
    storage: { getRange: async () => ok(body) },
  } as unknown as AfterVerifyContext;
  try {
    const refused = await afterVerify?.(context);
    if (refused === undefined) return "passed";
    return refused instanceof CloudropError && refused.code === "FILE_TYPE_NOT_ALLOWED" ? "refused" : `odd: ${refused}`;
  } catch (error) {
    return `threw ${error}`;
  }
}

// Slower than the lane's other tests by design: each of the two passes below reads more than 20,000 inputs, about
// 100 ms on an idle machine and up to 350 ms beside other lanes (measured 2026-11-21). The count is the ruling's.
describe("the sniffer and the content check on bytes no writer made (M11-R130)", () => {
  const made = inputs();

  it("builds at least 20,000 inputs", () => {
    expect(made.length).toBeGreaterThanOrEqual(20_000);
  });

  it("sniff answers null or a type with a name, whatever the bytes", () => {
    const wrong = made.filter((input) => {
      try {
        const sniffed = sniff(input, input.length);
        return sniffed !== null && !(typeof sniffed.type === "string" && typeof sniffed.name === "string");
      } catch {
        return true;
      }
    });
    expect(wrong.map(hex)).toEqual([]);
  });

  it("afterVerify passes or refuses every one of them, and never throws", async () => {
    const wrong: string[] = [];
    for (const [index, input] of made.entries()) {
      const answer = await verdict(input, DECLARED[index % DECLARED.length] ?? "text/plain");
      if (answer !== "passed" && answer !== "refused") wrong.push(`${hex(input)}: ${answer}`);
    }
    expect(wrong).toEqual([]);
  });
});

// XML 1.0 §2.8: doctypedecl is "<!DOCTYPE" S Name (S ExternalID)? S? ("[" intSubset "]" S?)? ">", and intSubset any
// run of markup declarations, comments (§2.5), processing instructions (§2.6), parameter-entity references and blanks.
// A system literal (§2.3) is any text without its own quote; a comment any text without "-" (wider is allowed, and not
// needed here); a processing instruction any text without "?>".
describe("the sniffer on doctypes built from the XML grammar (M11-R220)", () => {
  const text = (...without: string[]) =>
    fc
      .string({ unit: fc.constantFrom(...`]>[<!-?"'%; ax\n`), maxLength: 12 })
      .filter((made) => without.every((part) => !made.includes(part)));
  const literal = fc.oneof(
    text('"').map((value) => `"${value}"`),
    text("'").map((value) => `'${value}'`),
  );
  const part = fc.oneof(
    literal.map((value) => `<!ENTITY a SYSTEM ${value}>`),
    literal.map((value) => `<!NOTATION n SYSTEM ${value} >`),
    text("-").map((value) => `<!--${value}-->`),
    text("?>").map((value) => `<?p ${value}?>`),
    fc.constantFrom("<!ELEMENT x (a|b)*>", "%p;", " ", "\n"),
  );
  const doctype = fc
    .tuple(fc.option(literal), fc.option(fc.array(part, { maxLength: 8 })))
    .map(
      ([external, subset]) =>
        `<!DOCTYPE x${external ? ` SYSTEM ${external}` : ""}${subset ? ` [${subset.join("")}] ` : ""}>`,
    );

  it("finds the SVG root after every one of them, with and without an XML declaration", () => {
    fc.assert(
      fc.property(doctype, fc.constantFrom("", '<?xml version="1.0"?>\n'), (made, declaration) => {
        expect(sniff(bytes(`${declaration}${made}\n<svg onload=alert(1)>`))?.type).toBe("image/svg+xml");
      }),
      { numRuns: 2000 },
    );
  });
});
