// Fails when a TypeScript file under packages/*/src, scripts or examples/* (.ts and .tsx) is longer than its cap:
// `bun scripts/check-file-size.ts`. It reads the files Biome checks there: tracked ones and new ones git does not ignore,
// so a build's .next/ output is never counted.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_CAP = 250;
const TEST_CAP = 400;

interface OversizedFile {
  path: string;
  lines: number;
  cap: number;
}

/** Lines are counted as `wc -l` counts them: newline characters, so a last line without one is not counted. */
export function findOversizedFiles(files: ReadonlyArray<{ path: string; text: string }>): OversizedFile[] {
  const oversized: OversizedFile[] = [];
  for (const { path, text } of files) {
    const lines = text.split("\n").length - 1;
    const cap = path.endsWith(".test.ts") ? TEST_CAP : SOURCE_CAP;
    if (lines > cap) oversized.push({ path, lines, cap });
  }
  return oversized;
}

if (import.meta.main) {
  // The paths below are relative to the repository root; from any other directory git would list nothing.
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const listed = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ":(glob)packages/*/src/**/*.ts",
      ":(glob)scripts/**/*.ts",
      ":(glob)examples/*/**/*.ts",
      ":(glob)examples/*/**/*.tsx",
    ],
    { encoding: "utf8" },
  );
  // A file deleted but not yet staged is still listed; it has no lines to check.
  const paths = listed.split("\0").filter((path) => path && existsSync(path));
  const oversized = findOversizedFiles(paths.map((path) => ({ path, text: readFileSync(path, "utf8") })));
  if (oversized.length === 0) {
    console.log(`File sizes: ${paths.length} TypeScript files are within their caps.`);
  } else {
    for (const file of oversized) console.error(`${file.path}: ${file.lines} lines, cap ${file.cap}`);
    console.error(
      `Too long: the cap is ${SOURCE_CAP} lines for a source file and ${TEST_CAP} for a *.test.ts file. ` +
        "Split each file above by responsibility; the rule is in AGENTS.md.",
    );
    process.exit(1);
  }
}
