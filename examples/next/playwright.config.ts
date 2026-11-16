import { defineConfig, devices } from "@playwright/test";

// Run through scripts/test-browser.sh: it exports the settings that `next build` and the test's own `storage` need.
export default defineConfig({
  testDir: "app",
  testMatch: "**/*.browser.test.ts",
  workers: 1,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  use: {
    baseURL: "http://localhost:5173",
    // Off: a trace, video or screenshot can hold a presigned URL.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: {
    command: "bun run build && bun run start",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
