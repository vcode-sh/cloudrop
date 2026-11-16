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

const summed = { disablePlugins: ["@size-limit/esbuild"] };

export default [
  // Summed files, not a bundle: these budgets count the entry and its chunks as published.
  { name: "cloudrop", path: withImportedChunks("index.js"), gzip: true, limit: "36 kB", ...summed },
  { name: "cloudrop/next", path: withImportedChunks("next.js"), gzip: true, limit: "1.1 kB", ...summed },
  { name: "cloudrop/node", path: withImportedChunks("node.js"), gzip: true, limit: "3.2 kB", ...summed },
  // Bundled and minified, the size an app ships (spec §1: client plus React ~10 kB). Set after M3 progress plan A:
  // 6.71 kB measured plus ~10% (M3-U13). The owner's ceiling is 7.5 kB (spec §7), so plan B has about 0.8 kB left.
  {
    name: "cloudrop/client",
    path: join(dist, "client.js"),
    import: "{ createCloudropClient }",
    gzip: true,
    limit: "7.4 kB",
  },
];
