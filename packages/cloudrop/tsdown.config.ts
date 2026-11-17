import { defineConfig } from "tsdown";

export default defineConfig({
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
});
