import fc from "fast-check";
import { expect, it } from "vitest";
import { readOrigins } from "./origins.ts";

/** 0.5.0's whole rule for an origin, as `src/server/config.ts` had it at v0.5.0. */
const acceptedBy050 = (text: string): boolean => URL.canParse(text) && new URL(text).origin === text;

// What a host is typed with: the characters a browser loads a page from and, in one label of four, also the ones the
// URL standard forbids in a host or reads as the start of something else, and a letter that becomes punycode. Left
// out are "*", the punctuation the parser keeps ("$", "(", "&") and an empty label, which "/" would make of ":/":
// 0.5.0 took those and the rule now refuses them (M9-H100, M11-R176).
const PLAIN = [..."abcxyz0189_-"];
const OTHER = [..."ABC", "%41", " ", "@", ":", "[", "]", "\\", "^", "|", "<", "#", "?", "ü"];
const labelOf = (characters: string[]) =>
  fc.array(fc.constantFrom(...characters), { minLength: 1, maxLength: 6 }).map((typed) => typed.join(""));
const label = fc.oneof(
  { weight: 3, arbitrary: labelOf(PLAIN) },
  { weight: 1, arbitrary: labelOf([...PLAIN, ...OTHER]) },
);

const name = fc
  .tuple(fc.array(label, { minLength: 1, maxLength: 3 }), fc.constantFrom("", "", "."))
  .map(([labels, lastDot]) => labels.join(".") + lastDot);

// Numbers in a host are an address to the parser, which refuses some and rewrites others.
const number = fc.oneof(
  fc.integer({ min: 0, max: 300 }).map(String),
  fc.constantFrom("0x7f", "010", "999999999999", "4294967295", "4294967296"),
);
const numbers = fc.array(number, { minLength: 1, maxLength: 5 }).map((parts) => parts.join("."));

const address = fc.constantFrom(
  "[::1]",
  "[::ffff:102:304]",
  "[::ffff:1.2.3.4]",
  "[0:0:0:0:0:0:0:1]",
  "[2001:db8::1]",
  "[::1",
  "[g::1]",
  "[::1%eth0]",
);

const port = fc.oneof(
  { weight: 4, arbitrary: fc.constant("") },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 70_000 }).map((n) => `:${n}`) },
  { weight: 3, arbitrary: fc.constantFrom(":80", ":443", ":65535", ":65536", ":99999", ":080", ":", ":80a", ":-1") },
);

const origin = fc
  .tuple(
    fc.constantFrom("http", "https", "http", "https", "http", "https", "HTTPS", " https"),
    fc.constantFrom("://", "://", "://", "://", "://", "://", ":/", ":", "://user@", "://user:word@"),
    fc.oneof({ weight: 4, arbitrary: name }, numbers, address),
    port,
    fc.constantFrom("", "", "", "", "", "", "/", "/upload", "?a", "#a", "\n"),
  )
  .map((parts) => parts.join(""));

// One rule over a domain no list of rows covers: before M11-R230 the rule let through http and https text the parser
// refuses, a port typo among it. Of 4,000 origins about 330 are ones 0.5.0 accepted. About 60 ms.
it("an http or https origin is accepted exactly when 0.5.0 accepted it, and as the same text", () => {
  fc.assert(
    fc.property(origin, (text) => {
      expect(readOrigins([text])).toEqual(acceptedBy050(text) ? { origins: [text] } : { problem: expect.any(String) });
    }),
    { numRuns: 4000 },
  );
});
