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
      values: {
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
      },
      unclosed: [],
    });
  });

  it("reports a quote left open by its line number and keeps no value for it", () => {
    expect(parseEnvFile('A=1\nKEY="never closed\nB=2')).toEqual({ values: { A: "1", B: "2" }, unclosed: [2] });
  });
});
