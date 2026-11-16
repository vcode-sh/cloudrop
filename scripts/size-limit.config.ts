// Size budgets for the published entries of packages/cloudrop, read by size-limit in `bun run package:check`.
// The build moves code that entries share into hashed chunks, so each budget counts its entry together with every
// chunk the entry imports, directly or through another chunk: what a consumer's bundler pulls in for that import.
// Sizes are gzip, the unit the design spec states its size goals in. A budget is the size measured when it was set
// plus about 10%; raise one only on purpose, and say why in the commit.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dirname, "../packages/cloudrop/dist");

/** The entry and the chunks it imports, followed until no new file appears. */
function withImportedChunks(entry: string): string[] {
  const files = new Set([entry]);
  for (const file of files) {
    const code = readFileSync(join(dist, file), "utf8");
    // The build writes static imports as `import "./chunk.js"` or `import { a } from "./chunk.js"`.
    for (const [, chunk] of code.matchAll(/(?:import|from)\s*"\.\/([^"]+\.js)"/g)) if (chunk) files.add(chunk);
  }
  return [...files].map((file) => join(dist, file));
}

export default [
  { name: "cloudrop", path: withImportedChunks("index.js"), gzip: true, limit: "36 kB" },
  { name: "cloudrop/next", path: withImportedChunks("next.js"), gzip: true, limit: "1.1 kB" },
  { name: "cloudrop/node", path: withImportedChunks("node.js"), gzip: true, limit: "2.9 kB" },
];
