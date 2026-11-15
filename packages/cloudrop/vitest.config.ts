import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "../../scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
        },
      },
      {
        // Live services: uploads of several MiB and container start-up need longer limits.
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
