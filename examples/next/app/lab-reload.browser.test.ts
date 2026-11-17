// The lab's resume after a reload, in a real browser against a real S3 API, run by scripts/test-browser.sh (RustFS) or
// scripts/test-browser-live.ts (R2). A 20 MiB file on disk keeps its `lastModified` across the reload; one connection
// and a delay put the reload between part 1 and part 2, and the held /complete answer leaves a file stored while the
// page never hears of it. The oracle is the request sequence the resume promises (resume spec §3.4), the client's
// messages for a refused resume (§2.1) and the object read back through the example's own storage.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { storage } from "../lib/cloudrop";
import {
  chooseOnDisk,
  expectNoSignedUrl,
  fileRows,
  onDiskFile,
  partOneStored,
  requestRows,
  resumeWith,
  signIn,
  unfinishedRows,
} from "./lab-page";

const prefix = process.env.CLOUDROP_EXAMPLE_PREFIX;
if (!prefix)
  throw new Error(
    "CLOUDROP_EXAMPLE_PREFIX is not set. Run this test through `bun run test:browser` or `bun run test:browser:live`.",
  );

const TWENTY_MIB = 20_971_520;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Every object stored under the demo user's prefix, as [key, size]. */
async function storedObjects(): Promise<Map<string, number>> {
  const { data, error } = await storage.list(`${prefix}/demo/`);
  if (error) throw new Error(`Listing the demo user's uploads failed: ${error.message}`);
  if (data.nextCursor !== null) throw new Error("The demo user has more uploads than one list page holds.");
  return new Map(data.items.map(({ key, size }) => [key, size]));
}

/** The key the Result figure shows for the run's one file. */
async function resultKey(page: Page): Promise<string> {
  const text = (await page.getByRole("figure", { name: "Result" }).textContent()) ?? "";
  const key = /"key": "([^"]+)"/.exec(text)?.[1];
  if (!key) throw new Error("The Result figure shows no key.");
  return key;
}

/** Uploads `path` with one connection and every PUT delayed a second, and waits until part 1 is stored. */
async function uploadUntilPartOne(page: Page, path: string): Promise<void> {
  await page.getByLabel("Connections", { exact: true }).selectOption("1");
  // Part 2 waits a second before it is sent, far longer than a look at the table every 100 ms and a reload.
  await page.getByLabel(/Delay every bucket PUT by/).fill("1000");
  await chooseOnDisk(page, path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await partOneStored(page);
}

test("after a reload, the same file resumes with /complete and sends only the missing parts", async ({
  page,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  await uploadUntilPartOne(page, file.path);

  await page.reload();
  await expect.poll(() => unfinishedRows(page)).toEqual([[file.name, String(TWENTY_MIB)]]);
  await resumeWith(page, file.name, file.path);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  // The bucket has part 1 from before the reload: /complete names parts 2 and 3 missing, which alone are signed and sent.
  expect(await requestRows(page)).toEqual([
    ["/complete", "409", "resume: asks which parts are stored"],
    ["/sign", "200", "URLs for the missing part 2, 3"],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/complete", "200", ""],
  ]);
  expect(await fileRows(page)).toEqual([[file.name, "done"]]);
  await expect(page.getByText("No unfinished uploads.")).toBeVisible();
  const { data: stored, error } = await storage.getRange(await resultKey(page), 0, TWENTY_MIB - 1);
  expect(error).toBeNull();
  expect(sha256(stored ?? new Uint8Array())).toBe(sha256(await readFile(file.path)));
  await expectNoSignedUrl(page);
});

test("a file stored while its /complete answer was held resumes with /complete alone, under the same key", async ({
  page,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  await page.getByLabel("Hold /complete answers while ticked").check();
  const before = await storedObjects();
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect
    .poll(() => requestRows(page), { timeout: 20_000 })
    .toContainEqual(["/complete", "…", "answer held (the server sent 200)"]);
  const added = [...(await storedObjects())].filter(([key]) => !before.has(key));
  expect(added).toEqual([[expect.stringMatching(/\.bin$/), TWENTY_MIB]]);

  // The reload drops the held answer unheard; the hold is a page setting, so the reloaded page holds nothing.
  await page.reload();
  await expect.poll(() => unfinishedRows(page)).toEqual([[file.name, String(TWENTY_MIB)]]);
  await resumeWith(page, file.name, file.path);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  expect(await requestRows(page)).toEqual([["/complete", "200", "resume: asks which parts are stored"]]);
  expect(await resultKey(page)).toBe(added[0]?.[0]);
  expect([...(await storedObjects())].filter(([key]) => !before.has(key))).toEqual(added);
  await expect(page.getByText("No unfinished uploads.")).toBeVisible();
});

test("a different file picked to resume is refused before any request, and the upload stays resumable", async ({
  page,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  const other = await onDiskFile(testInfo, 5);
  await signIn(page);
  await uploadUntilPartOne(page, file.path);
  await page.reload();
  await expect.poll(() => unfinishedRows(page)).toEqual([[file.name, String(TWENTY_MIB)]]);

  await resumeWith(page, file.name, other.path);

  await expect(page.getByRole("status")).toHaveText(
    "This is not the file the upload started with. Pick the same file again to resume it.",
  );
  expect(await requestRows(page)).toEqual([]);
  expect(await unfinishedRows(page)).toEqual([[file.name, String(TWENTY_MIB)]]);
  // The refusal kept the record: the right file resumes it, which also leaves nothing unfinished in the bucket.
  await resumeWith(page, file.name, file.path);
  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
});

test("a resume in a second page is refused while the first page still sends the upload", async ({
  page,
  context,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  await uploadUntilPartOne(page, file.path);
  // Part 2 already waits its second; part 3 waits five, so the first page still sends while the second one resumes.
  await page.getByLabel(/Delay every bucket PUT by/).fill("5000");

  // A second page of the same browser context shares its storage, its locks and the sign-in cookie.
  const second = await context.newPage();
  await second.goto("/lab");
  await expect.poll(() => unfinishedRows(second)).toEqual([[file.name, String(TWENTY_MIB)]]);
  await resumeWith(second, file.name, file.path);

  await expect(second.getByRole("status")).toHaveText(
    "This upload is being sent in this browser, in this tab or another. Finish or cancel it there, then try again.",
  );
  expect(await requestRows(second)).toEqual([]);
  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  expect(await fileRows(page)).toEqual([[file.name, "done"]]);
});

test("Forget empties the list of unfinished uploads", async ({ page }) => {
  await signIn(page);
  const refuse = page.getByLabel("Refuse every bucket PUT with 400 while ticked");
  await refuse.check();
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("failed with UPLOAD_REJECTED");
  // A failed file keeps its record, so it can be retried, or resumed after a reload.
  await expect.poll(() => unfinishedRows(page)).toEqual([["random-20-MiB.bin", String(TWENTY_MIB)]]);

  await page.getByRole("button", { name: "Forget unfinished uploads" }).click();

  await expect(page.getByText("No unfinished uploads.")).toBeVisible();
  expect(await unfinishedRows(page)).toEqual([]);
  // Cleanup: Forget deletes records, not uploads. Leaving the page sends the failed file's /abort with keepalive, which
  // Playwright does not report from an unloading page; a missed one leaves an upload without parts (the lab refused
  // every PUT in the bucket's place), which the bucket's lifecycle rule aborts.
  await page.reload();
});
