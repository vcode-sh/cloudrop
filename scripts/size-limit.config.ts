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
  // Bundled and minified, what a Workers app ships for the server: every export, without the doc comments and messages
  // of the unminified files the summed budget counts. 21.33 kB when set (M4-F14).
  {
    name: "cloudrop (bundled)",
    path: join(dist, "index.js"),
    gzip: true,
    limit: "23.5 kB",
    // index.js has a bare `import "./types-….js"` that sideEffects: false lets esbuild drop, as it should; without
    // this every run prints that as a warning.
    modifyEsbuildConfig: (config: object) => ({ ...config, logOverride: { "ignored-bare-import": "silent" } }),
  },
  // Bundled and minified, the size an app ships. 8.35 kB after progress plan B. Owner decisions 2026-11-16: resume
  // after reload is on by default with a raised ceiling, and ceilings get headroom instead of step-by-step raises; the
  // resume plan measured 9.57 kB before its last feature task, so the ceiling was 10.5 kB. The final review's fixes
  // (M3-U88 to M3-U90) took the client to 10.57 kB, so by that headroom decision the ceiling is 11 kB (M3-U91). The
  // M4a fixes ended at 10.95 kB; resumable() leaving out the uploads this page holds took it to 11.03 kB, so the ceiling
  // is 11.5 kB, the step design §5.7 allows (M4-F23).
  {
    name: "cloudrop/client",
    path: join(dist, "client.js"),
    import: "{ createCloudropClient }",
    gzip: true,
    limit: "11.5 kB",
  },
  // Bundled and minified without react and without the client's chunks (the client and its errors), which an app that
  // uses the hooks ships anyway. react.js holds all of src/react, since no other entry imports it. The design aimed at
  // 1.5 kB (M4-B5); the hooks measured 2.07 kB with every promise of the contract kept, after the review's fixes added
  // the resumable list's tracking of held uploads, so the ceiling is that plus about 10% (M4-B10).
  {
    name: "cloudrop/react",
    path: join(dist, "react.js"),
    import: "{ createUploadHooks }",
    modifyEsbuildConfig: (config: { external?: string[] }) => ({
      ...config,
      external: [...(config.external ?? []), "react", "./client-*", "./errors-*"],
    }),
    gzip: true,
    limit: "2.3 kB",
  },
];
