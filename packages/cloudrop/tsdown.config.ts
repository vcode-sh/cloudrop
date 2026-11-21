import { dirname, join } from "node:path";
import { defineConfig, type UserConfig } from "tsdown";

const library = {
  // Keys are output paths: the adapters build to dist/adapters/<name>.js, as the package's exports map expects. The SQL
  // core they share (src/store/sql) lands in a chunk of its own once more than one adapter imports it.
  entry: {
    index: "src/index.ts",
    next: "src/next.ts",
    node: "src/node.ts",
    client: "src/client.ts",
    react: "src/react.ts",
    "adapters/sql": "src/adapters/sql.ts",
    "adapters/drizzle": "src/adapters/drizzle.ts",
    "adapters/prisma": "src/adapters/prisma.ts",
  },
  format: "esm",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  // The .d.ts files carry the docs an editor shows; JSDoc in the shipped .js only adds bytes to every app's bundle
  // (M4-F25). Annotations such as @__PURE__ stay, for tree shaking.
  outputOptions: { comments: { legal: true, annotation: true, jsdoc: false } },
} satisfies UserConfig;

/** The published entries cloudrop/testing builds on, by source file: the path each is imported by from dist/testing.js. */
const PUBLISHED = new Map([
  [join(import.meta.dirname, "src/index.ts"), "./index.js"],
  [join(import.meta.dirname, "src/client.ts"), "./client.js"],
]);

// cloudrop/testing is built on its own, so the library's entries are built exactly as without it (M9-T2). It imports
// cloudrop and cloudrop/client as an app does: their code and classes are shared, never copied into testing.js.
const testing = {
  ...library,
  entry: { testing: "src/testing.ts" },
  clean: false,
  plugins: [
    {
      name: "cloudrop-published-entries",
      resolveId(source: string, importer: string | undefined) {
        if (!importer || !source.startsWith(".")) return null;
        // The declaration build asks for the .ts sources too.
        const published = PUBLISHED.get(join(dirname(importer), source));
        return published ? { id: published, external: true } : null;
      },
    },
  ],
} satisfies UserConfig;

export default defineConfig([library, testing]);
