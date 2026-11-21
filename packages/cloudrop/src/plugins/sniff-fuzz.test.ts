import { describe, expect, it } from "vitest";
import { CloudropError, ok } from "../errors.ts";
import type { AfterVerifyContext } from "../server/plugins.ts";
import { bytes, HTML, JPEG, PNG, PROGRAM, SVG, zipEntry } from "../testing/file-samples.ts";
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

/** The hook's answer for `body` sent as `type`, or the text of what it threw. */
async function verdict(body: Uint8Array<ArrayBuffer>, type: string): Promise<string> {
  const { afterVerify } = contentChecks({ deny: ["video/*"] }).server ?? {};
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
