// The lab's "blocked as by a CORS rule" fault in a real browser against a real S3 API, run by scripts/test-browser.sh
// (RustFS) or scripts/test-browser-live.ts (R2). The lab fails each PUT before any byte leaves, as a preflight the
// bucket's rule refuses would. The oracle is spec 1.0 §2d (M12-E7): two attempts around one renewal, then
// BUCKET_BLOCKED, and a Retry on the same ticket. Measured in Playwright's Chromium headless shell only.
import { expect, test } from "@playwright/test";
import { fileRows, requestRows, signIn } from "./lab-page";

test("a file whose PUTs are blocked as by a CORS rule fails with BUCKET_BLOCKED, and Retry keeps its ticket", async ({
  page,
}) => {
  await signIn(page);
  const fault = page.getByLabel("Block every bucket PUT as a CORS rule that misses this page would, while ticked");
  await fault.check();
  await page.getByRole("button", { name: "1 KiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  // Two attempts around one renewal, not the six of a network error (M12-E7).
  await expect(page.getByRole("status")).toContainText("failed with BUCKET_BLOCKED", { timeout: 5_000 });
  const failed = await requestRows(page);
  expect(failed).toEqual([
    ["/upload", "200", ""],
    ["PUT single", "network error", "injected CORS block"],
    ["/sign", "200", "renewal"],
    ["PUT single", "network error", "retry; injected CORS block"],
  ]);
  await fault.uncheck();

  await page.getByRole("button", { name: "Retry random-1-KiB.bin", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed after Retry");
  // The same ticket: no /abort and no new /upload.
  expect((await requestRows(page)).slice(failed.length)).toEqual([
    ["PUT single", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  expect(await fileRows(page)).toEqual([["random-1-KiB.bin", "done"]]);
});
