// The home page's upload UI in a real browser against a real S3 API, run by scripts/test-browser.sh (RustFS) or
// scripts/test-browser-live.ts (R2). The oracle is the bytes this test created, read back through the example's own
// storage, the kinds of bucket request the page sent, and the client's own error codes and messages. Faults come from
// Playwright's routing of the bucket's requests, so the rows run unchanged on R2, where no proxy can sit in front.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page, type Route } from "@playwright/test";
import { storage } from "../lib/cloudrop";
import { onDiskFile } from "./lab-page";

const prefix = process.env.CLOUDROP_EXAMPLE_PREFIX;
if (!prefix)
  throw new Error(
    "CLOUDROP_EXAMPLE_PREFIX is not set. Run this test through `bun run test:browser` or `bun run test:browser:live`.",
  );

const MIB = 1024 * 1024;
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const ORIGIN = "http://localhost:5173";

const test = base.extend<{
  bucketPuts: string[];
  helloOnDisk: { path: string };
}>({
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
  // An on-disk file chosen through the native file chooser, where Chromium compares a new selection with the current
  // one; `setInputFiles` with a buffer fires `change` every time and cannot show that.
  helloOnDisk: async ({ page: _ }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "cloudrop-browser-"));
    const path = join(directory, "hello.txt");
    await writeFile(path, "hello cloudrop");
    await use({ path });
    await rm(directory, { recursive: true, force: true });
  },
});

/** Signs in through the page's form; the server answers with a redirect that reloads the page. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Sign in as the demo user" }).click(),
  ]);
}

/** The rows of the upload list for files named `name`, in start order. */
const fileRows = (page: Page, name: string): Locator =>
  page.getByRole("list", { name: "Uploads", exact: true }).getByRole("listitem").filter({ hasText: name });

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Waits until `row` says `${size}, stored as <prefix>/demo/<ulid>.<extension>` and returns the key. */
async function storedKey(row: Locator, size: string, extension: string): Promise<string> {
  const pattern = new RegExp(`${literal(size)}, stored as (${literal(`${prefix}/demo/`)}${ULID}\\.${extension})$`);
  // Longer than expect's default 5 s, for a 20 MiB upload over a slow link; the test's own 30 s still bounds it.
  await expect(row).toContainText(pattern, { timeout: 20_000 });
  const key = pattern.exec((await row.textContent()) ?? "")?.[1];
  if (!key) throw new Error("The row names no stored key.");
  return key;
}

/** Answers the page's bucket requests with `handle`; requests to the example itself pass through. */
const routeBucket = (page: Page, handle: (route: Route) => unknown) =>
  page.route((url) => url.origin !== ORIGIN, handle);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

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
  const zone = page.getByText("Drop files here, or click to choose");
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Drop to upload")).toBeVisible();
  await page.getByText("Drop to upload").dispatchEvent("drop", { dataTransfer });
  const key = await storedKey(fileRows(page, "big.bin"), "20.0 MiB", "bin");

  expect(bucketPuts.toSorted()).toEqual(["PUT part 1", "PUT part 2", "PUT part 3"]);
  expect(await storage.head(key)).toMatchObject({ data: { size: 20_971_520 }, error: null });
  // The four bytes around each part boundary: the end of one part and the start of the next.
  for (const boundary of [8 * MIB, 16 * MIB]) {
    const around = Uint8Array.from([-2, -1, 0, 1], (offset) => (boundary + offset) % 251);
    expect(await storage.getRange(key, boundary - 2, boundary + 1)).toEqual({ data: around, error: null });
  }
});

test("the same file chosen twice, by click and by keyboard, uploads twice", async ({ page, helloOnDisk }) => {
  await signIn(page);

  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Drop files here, or click to choose").click();
  await (await chooser).setFiles(helloOnDisk.path);
  const first = await storedKey(fileRows(page, "hello.txt").nth(0), "14 B", "txt");
  // Tab reaches the hidden input, and Enter opens the picker. Chromium fires `cancel`, not `change`, for an unchanged
  // selection unless the page clears the input.
  const again = page.waitForEvent("filechooser");
  await page.getByLabel("Files to upload").focus();
  await page.keyboard.press("Enter");
  await (await again).setFiles(helloOnDisk.path);
  const second = await storedKey(fileRows(page, "hello.txt").nth(1), "14 B", "txt");

  expect(second).not.toBe(first);
  expect(await storage.head(first)).toMatchObject({ data: { size: 14 }, error: null });
  expect(await storage.head(second)).toMatchObject({ data: { size: 14 }, error: null });
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
  await expect(page.getByText("0 of 1 uploaded, 0 B of 0 B, 1 failed")).toBeVisible();

  await page.unrouteAll();
  await page.getByRole("button", { name: "Retry refused.txt" }).click();
  const key = await storedKey(row, "13 B", "txt");

  expect(await storage.getRange(key, 0, 12)).toEqual({ data: new TextEncoder().encode("refused bytes"), error: null });
  await expect(row.getByRole("button", { name: "Retry refused.txt" })).toHaveCount(0);
});

test("Cancel stops a multipart upload and tells the server to delete it", async ({ page, bucketPuts }) => {
  await signIn(page);
  // Every bucket PUT is held, never answered: the file is mid-upload for as long as the test needs.
  await routeBucket(page, () => {});

  await page.getByLabel("Files to upload").setInputFiles({
    name: "cancelled.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(20 * MIB),
  });
  await expect.poll(() => bucketPuts.length).toBeGreaterThan(0);
  const abort = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/cloudrop/abort`);
  await page.getByRole("button", { name: "Cancel cancelled.bin" }).click();

  const row = fileRows(page, "cancelled.bin");
  await expect(row).toContainText("Cancelled");
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
  // Part 1 reaches the bucket; parts 2 and 3 are held, so the reload comes between them.
  await routeBucket(page, (route) =>
    new URL(route.request().url()).searchParams.get("partNumber") === "1" ? route.continue() : undefined,
  );
  const partOne = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("partNumber") === "1" && response.status() === 200,
  );
  await page.getByLabel("Files to upload").setInputFiles(file.path);
  await partOne;

  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  bucketPuts.length = 0;
  const panel = page.getByRole("list", { name: "Unfinished uploads" });
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel).toContainText(`${file.name}20.0 MiB, can be resumed until`);

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
  const bytes = await readFile(file.path);
  const { data: stored, error } = await storage.getRange(key, 0, bytes.length - 1);
  expect(error).toBeNull();
  expect(sha256(stored ?? new Uint8Array())).toBe(sha256(bytes));
});
