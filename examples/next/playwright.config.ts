import { defineConfig, devices } from "@playwright/test";

// Run through scripts/test-browser.sh (RustFS) or scripts/test-browser-live.ts (R2): they export the settings that
// `next build` and the test's own `storage` need. The live run sets an empty S3 endpoint, which means R2.
const onR2 = !process.env.CLOUDROP_S3_ENDPOINT;
// The lanes run twice: the stateless default with every row but the store rows, then the example with a database
// store (CLOUDROP_EXAMPLE_STORE) with the store rows alone.
const withStore = Boolean(process.env.CLOUDROP_EXAMPLE_STORE);

export default defineConfig({
  testDir: "app",
  testMatch: withStore ? "**/*.store.browser.test.ts" : "**/*.browser.test.ts",
  // The chaos rows fault requests through the proxy test-browser.sh puts in front of RustFS. R2 routes by its own
  // hostname, so nothing can sit in front of it (decision M3-K1): the live run leaves those files out.
  testIgnore: [...(onR2 ? ["**/*.chaos.browser.test.ts"] : []), ...(withStore ? [] : ["**/*.store.browser.test.ts"])],
  // One at a time: the chaos proxy's rules are global to the run.
  workers: 1,
  // Firefox and WebKit run the rows whose outcome depends on the engine's upload progress events: BUCKET_BLOCKED's rule
  // reads them, and Firefox reports none for a fast body whose answer is an error (M12-R60, M12-R61). The store pass
  // has no such row.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(withStore
      ? []
      : (["firefox", "webkit"] as const).map((name) => ({
          name,
          use: { ...devices[name === "firefox" ? "Desktop Firefox" : "Desktop Safari"] },
          testMatch: ["**/bucket-faults.chaos.browser.test.ts", "**/lab-blocked.browser.test.ts"],
          // Rows that drive Chromium through the DevTools Protocol, which the other engines lack.
          grepInvert: /@cdp/,
        }))),
  ],
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
