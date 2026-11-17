// The example with its database store (CLOUDROP_EXAMPLE_STORE), in a real browser against a real S3 API: the lanes'
// second pass, after every stateless row. A file stored while its /complete answer was held, then resumed after a
// reload, completes once: the user's usage counts it once and onComplete wrote its record once. A file over the quota
// is refused at /upload with QUOTA_EXCEEDED, before a byte is sent. The oracle is /api/usage, which reads
// cloudrop.api.usage and the app's own table, and the object read back through the example's storage.
import { expect, type Page, test } from "@playwright/test";
import type { UsageInfo } from "./api/usage/route";
import {
  chooseOnDisk,
  expectStoredAsResult,
  fileRows,
  onDiskFile,
  requestRows,
  resultKey,
  resumeWith,
  signIn,
  unfinishedRows,
} from "./lab-page";

const TWENTY_MIB = 20_971_520;

/** The signed-in user's usage, as the lab reads it. */
async function usage(page: Page): Promise<Extract<UsageInfo, { store: true }>> {
  const response = await page.request.get("/api/usage");
  expect(response.status()).toBe(200);
  const info = (await response.json()) as UsageInfo;
  if (!info.store) throw new Error("/api/usage reports no store. Run this file with CLOUDROP_EXAMPLE_STORE set.");
  return info;
}

test("a file stored while its /complete answer was held, resumed after a reload, is counted and recorded once", async ({
  page,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  const before = await usage(page);
  await page.getByLabel("Hold /complete answers while ticked").check();
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect
    .poll(() => requestRows(page), { timeout: 20_000 })
    .toContainEqual(["/complete", "…", "answer held (the server sent 200)"]);

  // The reload drops the held answer unheard: the server completed the file, the page never learnt it.
  await page.reload();
  await expect.poll(() => unfinishedRows(page)).toEqual([[file.name, String(TWENTY_MIB)]]);
  await resumeWith(page, file.name, file.path);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  // The resume's /complete finds the row completed and answers from it.
  expect(await requestRows(page)).toEqual([["/complete", "200", "resume: asks which parts are stored"]]);
  await expectStoredAsResult(page, file.path);
  const key = await resultKey(page);
  const after = await usage(page);
  expect(after).toEqual({
    ...before,
    activeBytes: before.activeBytes + TWENTY_MIB,
    files: before.files + 1,
    uploads: expect.any(Array),
  });
  expect(after.uploads).toHaveLength(before.uploads.length + 1);
  expect(after.uploads.filter((upload) => upload.key === key)).toEqual([{ key, size: TWENTY_MIB, completions: 1 }]);
  // The lab reads the same route at the end of the run.
  await expect(page.getByRole("table", { name: "Finished uploads" })).toContainText(key);
});

test("a file larger than the room left in the quota is refused with QUOTA_EXCEEDED before any byte is sent", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const before = await usage(page);
  // So 51 MiB never fits, whatever the first row left.
  expect(before.quotaBytes, "the lanes run the store pass with CLOUDROP_EXAMPLE_QUOTA_MB=50").toBe(50 * 1024 * 1024);
  const file = await onDiskFile(testInfo, 51);
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  await expect.poll(() => fileRows(page)).toEqual([[file.name, "failed: QUOTA_EXCEEDED"]]);
  expect((await requestRows(page)).map(([kind, status]) => [kind, status])).toEqual([["/upload", "200"]]);
  expect(await usage(page)).toEqual(before);
});
