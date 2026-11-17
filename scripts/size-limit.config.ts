// Size budgets for the published entries of packages/cloudrop, read by size-limit in `bun run package:check`.
// The build moves code that entries share into hashed chunks, so each budget counts its entry together with every
// chunk the entry imports, directly or through another chunk: what a consumer's bundler pulls in for that import.
// Sizes are gzip, the unit the design spec states its size goals in. Since 2026-11-17 the ceilings carry wide headroom
// for the work still to come (the store interface, plugins, the registry), by the owner's decision (M4-F24): a ceiling
// is a guard against accidents, not a target. The size measured then is noted beside each; a change that grows an
// entry by more than 5% says so in its commit and decision entry.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dist = join(import.meta.dirname, "../packages/cloudrop/dist");

/** The entry and the chunks it imports, followed until no new file appears. */
function withImportedChunks(entry: string): string[] {
  const files = new Set([entry]);
  for (const file of files) {
    const code = readFileSync(join(dist, file), "utf8");
    // The build writes static imports as `import "./chunk.js"` or `import { a } from "./chunk.js"`; an entry in a
    // subdirectory (dist/adapters/) reaches the chunks with "../".
    for (const [, chunk] of code.matchAll(/(?:import|from)\s*"(\.\.?\/[^"]+\.js)"/g)) {
      if (chunk) files.add(join(dirname(file), chunk));
    }
  }
  return [...files].map((file) => join(dist, file));
}

const summed = { disablePlugins: ["@size-limit/esbuild"] };

export default [
  // Summed files, not a bundle: these budgets count the entry and its chunks as published. Measured 2026-11-17:
  // cloudrop 36.7 kB, next 1.01 kB, node 3.1 kB.
  { name: "cloudrop", path: withImportedChunks("index.js"), gzip: true, limit: "50 kB", ...summed },
  { name: "cloudrop/next", path: withImportedChunks("next.js"), gzip: true, limit: "1.5 kB", ...summed },
  { name: "cloudrop/node", path: withImportedChunks("node.js"), gzip: true, limit: "4.5 kB", ...summed },
  // The database adapters, summed with their chunks: the SQL core (src/store/sql) counts toward each adapter that
  // imports it. Measured 2026-11-17: sql 10.26 kB (core and four executors; 5.89 kB bundled and minified, most of
  // it the SQL text; 9.62 kB before the core became a chunk shared with the ORM adapters); drizzle 20 B, a placeholder until its adapter lands, budgeted as the core plus 3 kB. prisma 11.8 kB
  // once it imported the core (its own file 0.89 kB, the core chunk 8.2 kB, route() for store.route 1.5 kB).
  { name: "cloudrop/adapters/sql", path: withImportedChunks("adapters/sql.js"), gzip: true, limit: "14 kB", ...summed },
  {
    name: "cloudrop/adapters/drizzle",
    path: withImportedChunks("adapters/drizzle.js"),
    gzip: true,
    limit: "13 kB",
    ...summed,
  },
  {
    name: "cloudrop/adapters/prisma",
    path: withImportedChunks("adapters/prisma.js"),
    gzip: true,
    limit: "13 kB",
    ...summed,
  },
  // Bundled and minified, what a Workers app ships for the server: every export, without the doc comments and messages
  // of the unminified files the summed budget counts (M4-F14). Measured 2026-11-17: 22.36 kB.
  {
    name: "cloudrop (bundled)",
    path: join(dist, "index.js"),
    gzip: true,
    limit: "30 kB",
    // index.js has a bare `import "./types-….js"` that sideEffects: false lets esbuild drop, as it should; without
    // this every run prints that as a warning.
    modifyEsbuildConfig: (config: object) => ({ ...config, logOverride: { "ignored-bare-import": "silent" } }),
  },
  // Bundled and minified, the size an app ships. History: 8.35 kB after progress plan B, 10.57 kB after resume
  // (M3-U91), 11.03 kB after M4a (M4-F23). Measured 2026-11-17: 11.03 kB.
  {
    name: "cloudrop/client",
    path: join(dist, "client.js"),
    import: "{ createCloudropClient }",
    gzip: true,
    limit: "15 kB",
  },
  // Bundled and minified without react and without the client's chunks (the client and its errors), which an app that
  // uses the hooks ships anyway. react.js holds all of src/react, since no other entry imports it (M4-B5, M4-B10).
  // Measured 2026-11-17: 1.96 kB.
  {
    name: "cloudrop/react",
    path: join(dist, "react.js"),
    import: "{ createUploadHooks }",
    modifyEsbuildConfig: (config: { external?: string[] }) => ({
      ...config,
      external: [...(config.external ?? []), "react", "./client-*", "./errors-*"],
    }),
    gzip: true,
    limit: "3 kB",
  },
];
