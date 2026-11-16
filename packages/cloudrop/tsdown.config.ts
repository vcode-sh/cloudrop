import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/next.ts", "src/node.ts"],
  format: "esm",
  platform: "neutral",
  dts: true,
  sourcemap: true,
});
