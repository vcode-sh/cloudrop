// Size budgets for the published entries of packages/cloudrop, read by size-limit in `bun run package:check`.
// The build moves code that entries share into hashed chunks, so each budget counts its entry together with every
// chunk the entry imports, directly or through another chunk: what a consumer's bundler pulls in for that import. The
// store entries (the adapters, cloudrop/store) count only what they add to cloudrop's own files (M12-S3).
// Sizes are gzip, the unit the design spec states its size goals in. On 2026-11-22 the owner raised every ceiling for
// 1.0, about 25% over the size each entry is expected to reach, so that a ceiling guards against accidents and never
// blocks work (M12-P1). It is not a target: the size measured is noted beside each, and the release summary reports
// the sizes measured for the release.
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

/**
 * The entry and the chunks it imports that index.js does not: what an import adds to an app that has `cloudrop`. The
 * server core the store code shares with the endpoints sits in a chunk index.js loads, which the cloudrop budget counts
 * (M12-S3).
 */
function beyondCloudrop(entry: string): string[] {
  const core = new Set(withImportedChunks("index.js"));
  return withImportedChunks(entry).filter((file) => !core.has(file));
}

const summed = { disablePlugins: ["@size-limit/esbuild"] };
/** index.js has a bare `import "./types-….js"` that sideEffects: false lets esbuild drop, as it should; without this
 *  every run prints that as a warning. */
const quietBareImport = (config: object) => ({ ...config, logOverride: { "ignored-bare-import": "silent" } });

export default [
  // Summed files, not a bundle: these budgets count the entry and its chunks as published. Measured 2026-11-17 after
  // M5's final fix round: cloudrop 46.08 kB, next 1.16 kB, node 3.24 kB; after the /upload idempotency key (M5-T104):
  // cloudrop 46.27 kB. Since the build drops JSDoc from the .js (M4-F25): cloudrop 37.01 kB, next 0.78 kB, node
  // 2.26 kB. After /abort's `keep` (M3-U94): cloudrop 37.09 kB. Measured 2026-11-21 for 0.6.0: cloudrop 46.79 kB,
  // next 0.83 kB, node 2.35 kB.
  // On 2026-11-22: cloudrop 47.08 kB before the store's code left index.js's chunks, 40.29 kB after (M12-S1).
  { name: "cloudrop", path: withImportedChunks("index.js"), gzip: true, limit: "60 kB", ...summed },
  { name: "cloudrop/next", path: withImportedChunks("next.js"), gzip: true, limit: "2 kB", ...summed },
  { name: "cloudrop/node", path: withImportedChunks("node.js"), gzip: true, limit: "5 kB", ...summed },
  // The database adapters, summed with their chunks: the SQL core (src/store/sql) with the adapters' route helper, and
  // route() (for store.route), count toward each adapter that imports them. Measured 2026-11-17 after M5's final fix
  // round: sql 13.72 kB (its own file 1.34 kB, the shared core chunk 9.36 kB), budgeted 18 kB (M5-T97); drizzle
  // 15.7 kB (its own file 3.31 kB), budgeted 17 kB (M5-T48); prisma 12.78 kB (its own file 0.72 kB), budgeted 16 kB
  // (M4-F24, M5-T58). After tables.schema (M5-T124): sql 13.94 kB, drizzle 15.94 kB, prisma 13.00 kB.
  // After the /upload idempotency key (M5-T104): sql 14.4 kB, drizzle 16.47 kB, prisma 13.47 kB. Both merged, then
  // without JSDoc in the .js (M4-F25): sql 10.84 kB, drizzle 12.64 kB, prisma 10.41 kB. Measured 2026-11-21 for
  // 0.6.0: sql 13.11 kB, drizzle 14.85 kB, prisma 12.59 kB. Since the store's code travels with the store (M12-S1),
  // each adapter carries it and counts only the files index.js does not load (M12-S3); measured 2026-11-22: sql
  // 22.06 kB, drizzle 23.8 kB, prisma 21.54 kB. Counted with index.js's chunks they were 35.61, 37.35 and 35.09 kB.
  { name: "cloudrop/adapters/sql", path: beyondCloudrop("adapters/sql.js"), gzip: true, limit: "32 kB", ...summed },
  {
    name: "cloudrop/adapters/drizzle",
    path: beyondCloudrop("adapters/drizzle.js"),
    gzip: true,
    limit: "34 kB",
    ...summed,
  },
  {
    name: "cloudrop/adapters/prisma",
    path: beyondCloudrop("adapters/prisma.js"),
    gzip: true,
    limit: "32 kB",
    ...summed,
  },
  // defineStore and the store's code, for a hand-written store, counted as the adapters are (M12-S2, M12-S3). Measured
  // 2026-11-22 when it was added: 10.64 kB.
  { name: "cloudrop/store", path: beyondCloudrop("store.js"), gzip: true, limit: "20 kB", ...summed },
  // Its own file only: index.js and client.js, which it imports, are the cloudrop and cloudrop/client budgets, and
  // only an app's tests load it (M9-T2). Measured 2026-11-21: 12.71 kB when it was added, 14.17 kB for 0.6.0.
  { name: "cloudrop/testing", path: join(dist, "testing.js"), gzip: true, limit: "30 kB", ...summed },
  // Its own file only, as cloudrop/testing: it imports CloudropError from index.js, which the cloudrop budget counts,
  // and only a server that installs a plugin loads it (M10-K5). Measured 2026-11-21 with contentChecks(): 5.05 kB;
  // 5.96 kB after the review fixes up to M11-R212, and 6.15 kB with a doctype read as an XML parser reads it, when the
  // ceiling went from 6 to 7 kB, which the owner confirmed for 0.6.0 (M11-R220). 6.27 kB with the ZIP64 extra field
  // read (M11-R221), and 6.46 kB after the final review's fixes (M11-R253 to M11-R258).
  { name: "cloudrop/plugins", path: join(dist, "plugins.js"), gzip: true, limit: "9 kB", ...summed },
  // Bundled and minified, what a Workers app ships for the server: every export, without the doc comments and messages
  // of the unminified files the summed budget counts (M4-F14). Measured 2026-11-17: 22.36 kB before M5, 27.19 kB
  // after its final fix round (M5-T69), 27.29 kB after the /upload idempotency key (M5-T104), 27.37 kB after /abort's
  // `keep` (M3-U94), 29.55 kB at 0.3.0 and 30.76 kB after onDelete and the file filters, when the ceiling went from 30
  // to 32 kB (M10-D10). 0.6.0's features and review fixes pass 32 kB: the owner set 36 kB for 0.6.0 (M11-R100).
  // Measured 2026-11-21 for 0.6.0: 34.71 kB. 28.25 kB on 2026-11-22 once the store's code left it (M12-S1), 29.47 kB
  // at the end of the 1.0 branch.
  {
    name: "cloudrop (bundled)",
    path: join(dist, "index.js"),
    gzip: true,
    limit: "40 kB",
    modifyEsbuildConfig: quietBareImport,
  },
  // Bundled and minified, what a server with a SQL store ships: createCloudrop and sqlStore (M12-S1). Measured
  // 2026-11-22: 33.61 kB when it was added, 46.4 kB at the end of the 1.0 branch, so the ceiling went from 50 to 60 kB
  // (owner, M12-R62).
  {
    name: "cloudrop + adapters/sql (bundled)",
    path: [join(dist, "index.js"), join(dist, "adapters/sql.js")],
    import: { [join(dist, "index.js")]: "{ createCloudrop }", [join(dist, "adapters/sql.js")]: "{ sqlStore }" },
    gzip: true,
    limit: "60 kB",
    modifyEsbuildConfig: quietBareImport,
  },
  // Bundled and minified, the size an app ships. History: 8.35 kB after progress plan B, 10.57 kB after resume
  // (M3-U91), 11.03 kB after M4a (M4-F23), 11.09 kB after the /upload idempotency key (M5-T104), 11.3 kB after
  // discard() (M3-U93), 11.32 kB once it sends `keep` (M3-U94). Measured 2026-11-21 for 0.6.0: 13.48 kB.
  {
    name: "cloudrop/client",
    path: join(dist, "client.js"),
    import: "{ createCloudropClient }",
    gzip: true,
    limit: "18 kB",
  },
  // Bundled and minified without react and without the client's chunks (the client and its errors), which an app that
  // uses the hooks ships anyway. react.js holds all of src/react, since no other entry imports it (M4-B5, M4-B10).
  // Measured 2026-11-17: 1.96 kB; 2.02 kB after useResumable's discard() and forget() (M4-B16); 2.26 kB on 2026-11-21
  // for 0.6.0.
  {
    name: "cloudrop/react",
    path: join(dist, "react.js"),
    import: "{ createUploadHooks }",
    modifyEsbuildConfig: (config: { external?: string[] }) => ({
      ...config,
      external: [...(config.external ?? []), "react", "./client-*", "./errors-*"],
    }),
    gzip: true,
    limit: "4 kB",
  },
];
