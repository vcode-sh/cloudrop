// What the lab's resume-after-reload rows stand on, in a real browser against a real S3 API, run by
// scripts/test-browser.sh (RustFS) or scripts/test-browser-live.ts (R2): a file on disk that a reload can pick again,
// one connection and a delay that put a reload between part 1 and part 2, and the held /complete answer that leaves a
// file stored while the page never hears of it. The oracle is the request sequence the client promises and the object
// read back through the example's own storage.
import { expect, test } from "@playwright/test";
import { storage } from "../lib/cloudrop";
import { chooseOnDisk, expectNoSignedUrl, fileRows, onDiskFile, partOneStored, requestRows, signIn } from "./lab-page";

const prefix = process.env.CLOUDROP_EXAMPLE_PREFIX;
if (!prefix)
  throw new Error(
    "CLOUDROP_EXAMPLE_PREFIX is not set. Run this test through `bun run test:browser` or `bun run test:browser:live`.",
  );

const TWENTY_MIB = 20_971_520;

const THREE_PARTS = [
  ["/upload", "200", ""],
  ["PUT part 1", "200", ""],
  ["PUT part 2", "200", ""],
  ["PUT part 3", "200", ""],
  ["/complete", "200", ""],
];

/** Every object stored under the demo user's prefix, as [key, size]. */
async function storedObjects(): Promise<Map<string, number>> {
  const { data, error } = await storage.list(`${prefix}/demo/`);
  if (error) throw new Error(`Listing the demo user's uploads failed: ${error.message}`);
  if (data.nextCursor !== null) throw new Error("The demo user has more uploads than one list page holds.");
  return new Map(data.items.map(({ key, size }) => [key, size]));
}

test("with one connection and a delay, part 1 is stored while part 2 still waits", async ({ page }, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  await page.getByLabel("Connections", { exact: true }).selectOption("1");
  // Every PUT waits a second, so part 2 cannot be stored between two looks at the table 100 ms apart.
  await page.getByLabel(/Delay every bucket PUT by/).fill("1000");
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  await partOneStored(page);

  const stored = (await requestRows(page)).filter(([kind, status]) => kind?.startsWith("PUT") && status === "200");
  expect(stored).toEqual([["PUT part 1", "200", "delayed 1000 ms"]]);
  expect(await fileRows(page)).toEqual([[file.name, "uploading"]]);
  // Cancelled, so the client's /abort removes the stored part and nothing is left in the bucket.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("cancelled");

  // After a reload the page has no run; the same file picked again from disk uploads as any file does.
  await page.reload();
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  expect(await requestRows(page)).toEqual(THREE_PARTS);
  expect(await fileRows(page)).toEqual([[file.name, "done"]]);
});

test("a held /complete leaves the file stored while the page waits, until the box is unticked", async ({
  page,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  const hold = page.getByLabel("Hold /complete answers while ticked");
  await hold.check();
  const before = await storedObjects();
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  await expect
    .poll(() => requestRows(page), { timeout: 20_000 })
    .toContainEqual(["/complete", "…", "answer held (the server sent 200)"]);
  // The server completed the file: one new object of the file's size, while the page still waits for /complete.
  const added = [...(await storedObjects())].filter(([key]) => !before.has(key));
  expect(added).toEqual([[expect.stringMatching(/\.bin$/), TWENTY_MIB]]);
  expect(await fileRows(page)).toEqual([[file.name, "completing"]]);
  await expect(page.getByRole("status")).toHaveText("Uploading…");

  await hold.uncheck();

  await expect(page.getByRole("status")).toContainText("completed");
  expect((await requestRows(page)).at(-1)).toEqual(["/complete", "200", "answer held (the server sent 200)"]);
  await expect(page.getByRole("figure", { name: "Result" })).toContainText(`"key": "${added[0]?.[0]}"`);
  // Unticked, the next run's /complete is answered at once: its rows replace the held run's.
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect.poll(() => requestRows(page), { timeout: 20_000 }).toEqual(THREE_PARTS);
  await expectNoSignedUrl(page);
});
