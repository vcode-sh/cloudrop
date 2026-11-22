// The lab's "blocked as by a CORS rule" fault in a real browser against a real S3 API, run by scripts/test-browser.sh
// (RustFS) or scripts/test-browser-live.ts (R2), in Chromium, Firefox and WebKit. The lab fails each PUT before any byte
// leaves, as a preflight the bucket's rule refuses would. The oracle is spec 1.0 §2d (M12-E7, M12-R60): six attempts
// around one renewal, then BUCKET_BLOCKED, retryable, and a Retry on the same ticket.
import { expect, test } from "@playwright/test";
import { fileRows, requestRows, signIn } from "./lab-page";

test("a file whose PUTs are blocked as by a CORS rule fails with BUCKET_BLOCKED, and Retry keeps its ticket", async ({
  page,
}) => {
  // Six attempts wait up to 0.5 + 1 + 2 + 4 + 8 s between them (M3-S9) before the file fails.
  test.setTimeout(60_000);
  await signIn(page);
  const fault = page.getByLabel("Block every bucket PUT as a CORS rule that misses this page would, while ticked");
  await fault.check();
  await page.getByRole("button", { name: "1 KiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  // The whole budget: only after it does the client tell a block from a lost connection (M12-R60).
  await expect(page.getByRole("status")).toContainText("failed with BUCKET_BLOCKED", { timeout: 30_000 });
  await expect(page.getByRole("figure", { name: "Result" })).toContainText('"retryable": true');
  const failed = await requestRows(page);
  expect(failed).toEqual([
    ["/upload", "200", ""],
    ["PUT single", "network error", "injected CORS block"],
    ["/sign", "200", "renewal"],
    ...Array(5).fill(["PUT single", "network error", "retry; injected CORS block"]),
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
