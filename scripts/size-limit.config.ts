// Size budgets for the published entries of packages/cloudrop, read by size-limit in `bun run package:check`.
// The build moves code that entries share into hashed chunks, so each budget counts its entry together with every
// chunk the entry imports, directly or through another chunk: what a consumer's bundler pulls in for that import.
// Sizes are gzip, the unit the design spec states its size goals in. Since 2026-11-17 the ceilings carry the wide
// headroom the owner set for the store interface, landed since, and the M6 plugins (M4-F24): a ceiling is a guard
// against accidents, not a target. The size measured then is noted beside each; a change that grows an entry by more
// than 5% says so in its commit and decision entry.
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
  // Summed files, not a bundle: these budgets count the entry and its chunks as published. Measured 2026-11-17 after
  // M5's final fix round: cloudrop 46.08 kB, next 1.16 kB, node 3.24 kB; after the /upload idempotency key (M5-T104):
  // cloudrop 46.27 kB. Since the build drops JSDoc from the .js (M4-F25): cloudrop 37.01 kB, next 0.78 kB, node
  // 2.26 kB. After /abort's `keep` (M3-U94): cloudrop 37.09 kB.
  { name: "cloudrop", path: withImportedChunks("index.js"), gzip: true, limit: "50 kB", ...summed },
  { name: "cloudrop/next", path: withImportedChunks("next.js"), gzip: true, limit: "1.5 kB", ...summed },
  { name: "cloudrop/node", path: withImportedChunks("node.js"), gzip: true, limit: "4.5 kB", ...summed },
  // The database adapters, summed with their chunks: the SQL core (src/store/sql) with the adapters' route helper, and
  // route() (for store.route), count toward each adapter that imports them. Measured 2026-11-17 after M5's final fix
  // round: sql 13.72 kB (its own file 1.34 kB, the shared core chunk 9.36 kB), budgeted 18 kB (M5-T97); drizzle
  // 15.7 kB (its own file 3.31 kB), budgeted 17 kB (M5-T48); prisma 12.78 kB (its own file 0.72 kB), budgeted 16 kB
  // (M4-F24, M5-T58). After tables.schema (M5-T124): sql 13.94 kB, drizzle 15.94 kB, prisma 13.00 kB.
  // After the /upload idempotency key (M5-T104): sql 14.4 kB, drizzle 16.47 kB, prisma 13.47 kB. Both merged, then
  // without JSDoc in the .js (M4-F25): sql 10.84 kB, drizzle 12.64 kB, prisma 10.41 kB.
  { name: "cloudrop/adapters/sql", path: withImportedChunks("adapters/sql.js"), gzip: true, limit: "18 kB", ...summed },
  {
    name: "cloudrop/adapters/drizzle",
    path: withImportedChunks("adapters/drizzle.js"),
    gzip: true,
    limit: "17 kB",
    ...summed,
  },
  {
    name: "cloudrop/adapters/prisma",
    path: withImportedChunks("adapters/prisma.js"),
    gzip: true,
    limit: "16 kB",
    ...summed,
  },
  // Its own file only: index.js and client.js, which it imports, are the cloudrop and cloudrop/client budgets, and
  // only an app's tests load it (M9-T2). Measured 2026-11-21: 12.71 kB.
  { name: "cloudrop/testing", path: join(dist, "testing.js"), gzip: true, limit: "16 kB", ...summed },
  // Bundled and minified, what a Workers app ships for the server: every export, without the doc comments and messages
  // of the unminified files the summed budget counts (M4-F14). Measured 2026-11-17: 22.36 kB before M5, 27.19 kB
  // after its final fix round (M5-T69), 27.29 kB after the /upload idempotency key (M5-T104), 27.37 kB after /abort's
  // `keep` (M3-U94), 29.55 kB at 0.3.0 and 30.71 kB after onDelete and the file filters, when the ceiling went from 30
  // to 32 kB (M10-D10).
  {
    name: "cloudrop (bundled)",
    path: join(dist, "index.js"),
    gzip: true,
    limit: "32 kB",
    // index.js has a bare `import "./types-….js"` that sideEffects: false lets esbuild drop, as it should; without
    // this every run prints that as a warning.
    modifyEsbuildConfig: (config: object) => ({ ...config, logOverride: { "ignored-bare-import": "silent" } }),
  },
  // Bundled and minified, the size an app ships. History: 8.35 kB after progress plan B, 10.57 kB after resume
  // (M3-U91), 11.03 kB after M4a (M4-F23), 11.09 kB after the /upload idempotency key (M5-T104), 11.3 kB after
  // discard() (M3-U93), 11.32 kB once it sends `keep` (M3-U94).
  {
    name: "cloudrop/client",
    path: join(dist, "client.js"),
    import: "{ createCloudropClient }",
    gzip: true,
    limit: "15 kB",
  },
  // Bundled and minified without react and without the client's chunks (the client and its errors), which an app that
  // uses the hooks ships anyway. react.js holds all of src/react, since no other entry imports it (M4-B5, M4-B10).
  // Measured 2026-11-17: 1.96 kB; 2.02 kB after useResumable's discard() and forget() (M4-B16).
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
