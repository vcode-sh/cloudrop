import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.ts";

describe("parseEnvFile", () => {
  it("reads values the way Node's --env-file does", () => {
    const text = [
      "# a comment line",
      "",
      "PLAIN=abc",
      "export EXPORTED=def",
      "  SPACED = ghi  ",
      "HASHED=abc#def",
      "COMMENTED=abc # note",
      'DOUBLE="a b # not a comment"',
      "SINGLE='a\\nb'",
      "BACKTICK=`x'y\"z`",
      'NEWLINE="one\\ntwo"',
      "EMPTY=",
      "DUPLICATE=first",
      "DUPLICATE=second",
      "not a line",
    ].join("\r\n");
    expect(parseEnvFile(text)).toEqual({
      PLAIN: "abc",
      EXPORTED: "def",
      SPACED: "ghi",
      HASHED: "abc",
      COMMENTED: "abc",
      DOUBLE: "a b # not a comment",
      SINGLE: "a\\nb",
      BACKTICK: "x'y\"z",
      NEWLINE: "one\ntwo",
      EMPTY: "",
      DUPLICATE: "second",
    });
  });

  it("reads a quoted value over several lines, and keeps a quote never closed as written, as Node does", () => {
    // Measured with node --env-file on Node 24.22: a PEM key in quotes spans lines; an open quote stays in the value.
    const text = 'KEY="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nAFTER=1\nOPEN="never\nLAST=2';
    expect(parseEnvFile(text)).toEqual({
      KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      AFTER: "1",
      OPEN: '"never',
      LAST: "2",
    });
  });

  it("consumes a multi-line value under a name with dots or hyphens, so its lines set no variable", () => {
    expect(parseEnvFile('my.key="line1\nCLOUDROP_SECRET=inside\nend"\nAFTER=1')).toEqual({
      "my.key": "line1\nCLOUDROP_SECRET=inside\nend",
      AFTER: "1",
    });
  });
});
