import { describe, expect, it } from "vitest";
import { findOversizedFiles } from "./check-file-size.ts";

const lines = (count: number): string => "line\n".repeat(count);

describe("findOversizedFiles", () => {
  it.each([
    { name: "a source file of exactly 250 lines", path: "packages/cloudrop/src/plan.ts", text: lines(250) },
    { name: "a test file of exactly 400 lines", path: "packages/cloudrop/src/plan.test.ts", text: lines(400) },
    {
      name: "a 251st line without a newline, which wc -l does not count",
      path: "scripts/rustfs.ts",
      text: `${lines(250)}last`,
    },
  ])("passes $name", ({ path, text }) => {
    expect(findOversizedFiles([{ path, text }])).toEqual([]);
  });

  it.each([
    {
      name: "a source file one line over",
      path: "packages/cloudrop/src/plan.ts",
      text: lines(251),
      expected: { path: "packages/cloudrop/src/plan.ts", lines: 251, cap: 250 },
    },
    {
      name: "a test file one line over the test cap",
      path: "packages/cloudrop/src/plan.test.ts",
      text: lines(401),
      expected: { path: "packages/cloudrop/src/plan.test.ts", lines: 401, cap: 400 },
    },
    {
      name: "a test helper that is not itself a test file, against the source cap",
      path: "packages/cloudrop/src/testing/server-fixture.ts",
      text: lines(251),
      expected: { path: "packages/cloudrop/src/testing/server-fixture.ts", lines: 251, cap: 250 },
    },
  ])("reports $name", ({ path, text, expected }) => {
    expect(findOversizedFiles([{ path, text }])).toEqual([expected]);
  });
});
