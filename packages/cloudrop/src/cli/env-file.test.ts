import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parseEnvFile } from "./env-file.ts";

const parsed = (text: string) => Object.fromEntries(parseEnvFile(text));

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
    expect(parsed(text)).toEqual({
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
    expect(parsed(text)).toEqual({
      KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      AFTER: "1",
      OPEN: '"never',
      LAST: "2",
    });
  });

  it("consumes a multi-line value under a name with dots or hyphens, so its lines set no variable", () => {
    expect(parsed('my.key="line1\nCLOUDROP_SECRET=inside\nend"\nAFTER=1')).toEqual({
      "my.key": "line1\nCLOUDROP_SECRET=inside\nend",
      AFTER: "1",
    });
  });

  // The oracle is the Node that runs the test: what its own parser makes of the same text (M11-R112). Each row is a
  // file another dotenv reader takes differently, so "the command reads it" must mean "Node reads it".
  it.each([
    { name: "a byte order mark, which stays in the first name", text: "﻿FIRST=1\nSECOND=2" },
    { name: "a tab after export, which stays in the name", text: "export\tTABBED=1\nexport  SPACED=2" },
    { name: "a space inside a name", text: "MY NAME=1\nNEXT=2" },
    { name: "line ends of CR alone, which end no line", text: "A=1\rB=2\rC=3" },
    { name: "CR inside a quoted value", text: 'A="x\r\ny"\r\nB=2' },
    { name: "a name with nothing after =, which keeps its export", text: "export BARE=\nNEXT=2" },
    { name: "spaces alone after =, which take the next line as the value", text: "A=  \nB=2\nC=3" },
    { name: "a line without =, and one without a name", text: "JUSTNAME\n=1\nB=2" },
    { name: "# in a name and at the start of a value", text: "B#C=2\nD=#x\nE= #x" },
    { name: "text after a closing quote", text: 'A="x" # c\nB=\'y\'z\nC="a"b"' },
    { name: "a quote never closed on the last line", text: 'B=2\nA="never' },
    { name: "escapes other than \\n in double quotes", text: 'A="a\\tb\\nc\\\\n"\nB=`a\\nb`' },
    { name: "a no-break space, which is not trimmed", text: "A= 1 \nB=2" },
    { name: "blank lines, comments and trailing spaces", text: "\n\n# c\n  A=1  \n\n#B=2\n\tC\t=\t3\t\n" },
  ])("reads $name as Node's util.parseEnv does", ({ text }) => {
    expect(parsed(text)).toEqual({ ...parseEnv(text) });
  });
});
