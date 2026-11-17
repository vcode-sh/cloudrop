import { defineConfig, devices } from "@playwright/test";

// Run through scripts/test-browser.sh, which starts Postgres and RustFS, applies the Hono example's migrations and
// exports the settings both servers and the tests read.
export default defineConfig({
  testDir: "src",
  testMatch: "**/*.browser.test.ts",
  // One at a time: a row's bucket PUTs are told apart from another's only by running alone.
  workers: 1,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  use: {
    baseURL: "http://localhost:5173",
    // Off: a trace, video or screenshot can hold a presigned URL.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: [
    {
      command: "bun run start",
      cwd: "../hono",
      url: "http://localhost:5181/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "bun run build && bun run preview",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
