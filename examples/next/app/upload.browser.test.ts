// The home page's upload UI in a real browser against a real S3 API, run by scripts/test-browser.sh (RustFS) or
// scripts/test-browser-live.ts (R2). The oracle is the bytes this test created, read back through the example's own
// storage, the kinds of bucket request the page sent, the client's own error codes and messages, and where keyboard
// focus lands. Faults come from Playwright's routing of the bucket's requests, so the rows run unchanged on R2, where no
// proxy can sit in front.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import { storage } from "../lib/cloudrop";
import { fileRows, leaveUnfinished, ORIGIN, routeBucket, signIn, storedKey, unfinishedList } from "./home-page";
import { onDiskFile } from "./lab-page";

const MIB = 1024 * 1024;

const test = base.extend<{ bucketPuts: string[] }>({
  // Labels such as "PUT part 2", never the URL: a presigned URL must not reach a log or a failure message.
  bucketPuts: async ({ page }, use) => {
    const labels: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "PUT") return;
      const part = new URL(request.url()).searchParams.get("partNumber");
      labels.push(part ? `PUT part ${part}` : "PUT");
    });
    await use(labels);
  },
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The object at `key`, read back through the example's storage, holds the file at `path`. */
async function expectStored(key: string, path: string): Promise<void> {
  const bytes = await readFile(path);
  const { data: stored, error } = await storage.getRange(key, 0, bytes.length - 1);
  expect(error).toBeNull();
  expect(sha256(stored ?? new Uint8Array())).toBe(sha256(bytes));
}

test("a picked file uploads in one PUT and its row shows the stored key", async ({ page, bucketPuts }) => {
  const bytes = new TextEncoder().encode("hello cloudrop");
  await signIn(page);

  await page
    .getByLabel("Files to upload")
    .setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from(bytes) });
  const key = await storedKey(fileRows(page, "hello.txt"), "14 B", "txt");

  expect(bucketPuts).toEqual(["PUT"]);
  expect(await storage.head(key)).toMatchObject({ data: { size: 14, type: "text/plain" }, error: null });
  expect(await storage.getRange(key, 0, 13)).toEqual({ data: bytes, error: null });
  await expect(page.getByText("1 of 1 uploaded, 14 B of 14 B")).toBeVisible();
});

test("a 20 MiB file dropped on the zone uploads in three parts", async ({ page, bucketPuts }) => {
  await signIn(page);

  // A drop carries a DataTransfer made in the page; 0, 1, …, 250, 0, …: a part cut at the wrong byte reads back wrong.
  const dataTransfer = await page.evaluateHandle((length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) bytes[index] = index % 251;
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "big.bin", { type: "application/octet-stream" }));
    return transfer;
  }, 20 * MIB);
  await page.getByText("Drop files here, or click to choose").dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Drop to upload")).toBeVisible();
  await page.getByText("Drop to upload").dispatchEvent("drop", { dataTransfer });
  const key = await storedKey(fileRows(page, "big.bin"), "20.0 MiB", "bin");

  expect(bucketPuts.toSorted()).toEqual(["PUT part 1", "PUT part 2", "PUT part 3"]);
  expect(await storage.head(key)).toMatchObject({ data: { size: 20_971_520 }, error: null });
  // The four bytes around each part boundary, of the pattern above: 8 MiB is 188 mod 251, 16 MiB is 125.
  expect(await storage.getRange(key, 8 * MIB - 2, 8 * MIB + 1)).toEqual({
    data: new Uint8Array([186, 187, 188, 189]),
    error: null,
  });
  expect(await storage.getRange(key, 16 * MIB - 2, 16 * MIB + 1)).toEqual({
    data: new Uint8Array([123, 124, 125, 126]),
    error: null,
  });
});

test("the same file chosen twice, by click and by Tab and Enter, uploads twice", async ({ page }, testInfo) => {
  // On disk and through the native chooser, where Chromium compares a new selection with the current one.
  const file = await onDiskFile(testInfo, 1);
  await signIn(page);

  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Drop files here, or click to choose").click();
  await (await chooser).setFiles(file.path);
  const first = await storedKey(fileRows(page, file.name).nth(0), "1.0 MiB", "bin");
  // Tab from the sign-in button reaches the hidden input, and Enter opens the picker. Chromium fires `cancel`, not
  // `change`, for an unchanged selection unless the page clears the input.
  await page.getByRole("button", { name: "Sign in as the demo user" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Files to upload")).toBeFocused();
  const again = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await again).setFiles(file.path);
  const second = await storedKey(fileRows(page, file.name).nth(1), "1.0 MiB", "bin");

  expect(second).not.toBe(first);
  await expectStored(first, file.path);
  await expectStored(second, file.path);
});

test("before sign-in a file fails with the server's code and message", async ({ page, bucketPuts }) => {
  await page.goto("/");

  await page
    .getByLabel("Files to upload")
    .setInputFiles({ name: "early.txt", mimeType: "text/plain", buffer: Buffer.from("too early") });

  await expect(fileRows(page, "early.txt")).toContainText("UNAUTHORIZED: Sign in as the demo user first.");
  await expect(page.getByRole("button", { name: "Retry early.txt" })).toBeVisible();
  expect(bucketPuts).toEqual([]);
});

test("a file the bucket refuses shows the error, and Retry sends it again", async ({ page }) => {
  await signIn(page);
  // The bucket's place: a 400 with the CORS header, so the page reads the status instead of a network error.
  await routeBucket(page, (route) =>
    route.fulfill({ status: 400, headers: { "access-control-allow-origin": ORIGIN }, body: "" }),
  );

  await page
    .getByLabel("Files to upload")
    .setInputFiles({ name: "refused.txt", mimeType: "text/plain", buffer: Buffer.from("refused bytes") });
  const row = fileRows(page, "refused.txt");
  await expect(row).toContainText(
    "UPLOAD_REJECTED: The storage service refused the file (HTTP 400). Start the upload again, and contact the site owner if it keeps failing.",
  );
  await expect(page.getByText("0 of 1 uploaded, 1 failed")).toBeVisible();

  await page.unrouteAll();
  await page.getByRole("button", { name: "Retry refused.txt" }).click();
  const key = await storedKey(row, "13 B", "txt");

  expect(await storage.getRange(key, 0, 12)).toEqual({ data: new TextEncoder().encode("refused bytes"), error: null });
});

test("keyboard focus stays on Pause and Resume, and Cancel moves it to the row before telling the server", async ({
  page,
  bucketPuts,
}) => {
  await signIn(page);
  // Every bucket PUT is held, never answered: the file is mid-upload for as long as the test needs.
  await routeBucket(page, () => {});

  await page.getByLabel("Files to upload").setInputFiles({
    name: "cancelled.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(20 * MIB),
  });
  await expect.poll(() => bucketPuts.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause cancelled.bin" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Resume cancelled.bin" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Pause cancelled.bin" })).toBeFocused();

  const abort = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/cloudrop/abort`);
  await page.getByRole("button", { name: "Cancel cancelled.bin" }).focus();
  await page.keyboard.press("Enter");

  const row = fileRows(page, "cancelled.bin");
  await expect(row).toContainText("Cancelled");
  await expect(row).toBeFocused();
  expect((await abort).status()).toBe(200);
  await expect(row.getByRole("button")).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("after a reload, the unfinished panel resumes with the same file and sends only the missing parts", async ({
  page,
  bucketPuts,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  const other = await onDiskFile(testInfo, 1);
  await signIn(page);
  await leaveUnfinished(page, [file.path]);
  bucketPuts.length = 0;
  const panel = unfinishedList(page);
  await expect(panel).toContainText(file.name);
  await expect(panel.getByText(/^20\.0 MiB, can be resumed until /)).toBeVisible();

  // Another file is refused before any request, as a failed row, and the upload stays listed.
  await panel.getByLabel(`Pick ${file.name} again to resume`).setInputFiles(other.path);
  await expect(fileRows(page, other.name)).toContainText(
    "INVALID_INPUT: This is not the file the upload started with. Pick the same file again to resume it.",
  );
  await expect(panel.getByRole("listitem")).toHaveCount(1);

  await panel.getByLabel(`Pick ${file.name} again to resume`).setInputFiles(file.path);
  const key = await storedKey(fileRows(page, file.name), "20.0 MiB", "bin");

  expect(bucketPuts.toSorted()).toEqual(["PUT part 2", "PUT part 3"]);
  await expect(page.getByRole("heading", { name: "Unfinished uploads" })).toHaveCount(0);
  await expectStored(key, file.path);
});

test("Discard drops one unfinished upload without its file, focus moves to the other's Discard, and it still resumes", async ({
  page,
}, testInfo) => {
  const kept = await onDiskFile(testInfo, 20);
  const dropped = await onDiskFile(testInfo, 17);
  await signIn(page);
  await leaveUnfinished(page, [kept.path, dropped.path]);

  const abort = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/cloudrop/abort`);
  await unfinishedList(page)
    .getByRole("button", { name: `Discard ${dropped.name}` })
    .focus();
  await page.keyboard.press("Enter");
  expect((await abort).status()).toBe(200);
  await expect(unfinishedList(page).getByRole("listitem")).toHaveCount(1);
  await expect(unfinishedList(page).getByRole("button", { name: `Discard ${kept.name}` })).toBeFocused();

  // The browser's record is gone too: a reload lists only the upload that was kept.
  await page.reload();
  await expect(unfinishedList(page).getByRole("listitem")).toHaveCount(1);
  await expect(unfinishedList(page)).toContainText(kept.name);
  await unfinishedList(page).getByLabel(`Pick ${kept.name} again to resume`).setInputFiles(kept.path);
  await expectStored(await storedKey(fileRows(page, kept.name), "20.0 MiB", "bin"), kept.path);
});
