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
          exclude: [
            ...configDefaults.exclude,
            "src/**/*.chaos.integration.test.ts",
            "src/**/*.soak.integration.test.ts",
            "src/**/*.db.integration.test.ts",
          ],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Postgres in Docker and SQLite through node:sqlite (scripts/test-db.sh).
        test: {
          name: "db",
          include: ["src/**/*.db.integration.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // RustFS behind the chaos proxy (scripts/test-chaos.sh); a row may wait out a Retry-After or a slow link.
        test: {
          name: "chaos",
          include: ["src/**/*.chaos.integration.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // The nightly lane (`scripts/test-chaos.sh soak`): jobs under seeded random faults (M3-K7, audit I3) and the
        // real-time stall and throttle rows (M3-K10).
        test: {
          name: "soak",
          include: ["src/**/*.soak.integration.test.ts"],
          testTimeout: 600_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
