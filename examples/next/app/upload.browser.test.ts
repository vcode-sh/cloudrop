// The quickstart in a real browser against a real S3 API, run by scripts/test-browser.sh. The oracle is the bytes this
// test created, read back through the example's own storage, and the kinds of bucket request the page sent.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { storage } from "../lib/cloudrop";

const prefix = process.env.CLOUDROP_EXAMPLE_PREFIX;
if (!prefix)
  throw new Error(
    "CLOUDROP_EXAMPLE_PREFIX is not set. Run this test through `bun run test:browser` or `bun run test:browser:live`.",
  );

const MIB = 1024 * 1024;
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

const test = base.extend<{
  bucketPuts: string[];
  helloOnDisk: { choose: () => Promise<void> };
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
  helloOnDisk: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "cloudrop-browser-"));
    const path = join(directory, "hello.txt");
    await writeFile(path, "hello cloudrop");
    await use({
      choose: async () => {
        const chooser = page.waitForEvent("filechooser");
        await page.getByLabel("File to upload").click();
        await (await chooser).setFiles(path);
      },
    });
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

/** Waits for the page's line `${start} <prefix>/demo/<ulid>.<extension>` and returns the key it names. */
async function uploadedKey(page: Page, start: string, extension: string): Promise<string> {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`^${literal(start)} (${literal(`${prefix}/demo/`)}${ULID}\\.${extension})$`);
  const status = page.getByRole("status");
  // Longer than expect's default 5 s, for a 20 MiB upload over a slow link; the test's own 30 s still bounds it.
  await expect(status).toHaveText(pattern, { timeout: 20_000 });
  const text = (await status.textContent()) ?? "";
  const key = pattern.exec(text)?.[1];
  if (!key) throw new Error(`The status line names no uploaded key: "${text}".`);
  return key;
}

/** 0, 1, …, 250, 0, 1, …: a part sent at the wrong offset or cut at the wrong byte reads back different. */
function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = index % 251;
  return bytes;
}

test("uploads a small file with one PUT", async ({ page, bucketPuts }) => {
  const bytes = new TextEncoder().encode("hello cloudrop");
  await signIn(page);

  await page
    .getByLabel("File to upload")
    .setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from(bytes) });
  const key = await uploadedKey(page, "Uploaded hello.txt (14 bytes) as", "txt");

  expect(bucketPuts).toEqual(["PUT"]);
  expect(await storage.head(key)).toMatchObject({ data: { size: 14, type: "text/plain" }, error: null });
  expect(await storage.getRange(key, 0, 13)).toEqual({ data: bytes, error: null });
});

test("uploads a 20 MiB file in three parts", async ({ page, bucketPuts }) => {
  const bytes = patternBytes(20 * MIB);
  await signIn(page);

  await page
    .getByLabel("File to upload")
    .setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.from(bytes.buffer) });
  const key = await uploadedKey(page, "Uploaded big.bin (20971520 bytes) as", "bin");

  expect(bucketPuts.toSorted()).toEqual(["PUT part 1", "PUT part 2", "PUT part 3"]);
  expect(await storage.head(key)).toMatchObject({ data: { size: 20_971_520 }, error: null });
  // The four bytes around each part boundary: the end of one part and the start of the next.
  expect(await storage.getRange(key, 8 * MIB - 2, 8 * MIB + 1)).toEqual({
    data: bytes.slice(8 * MIB - 2, 8 * MIB + 2),
    error: null,
  });
  expect(await storage.getRange(key, 16 * MIB - 2, 16 * MIB + 1)).toEqual({
    data: bytes.slice(16 * MIB - 2, 16 * MIB + 2),
    error: null,
  });
});

test("uploads the same file chosen twice", async ({ page, helloOnDisk }) => {
  await signIn(page);

  await helloOnDisk.choose();
  const first = await uploadedKey(page, "Uploaded hello.txt (14 bytes) as", "txt");
  await helloOnDisk.choose();
  // Chromium fires `cancel`, not `change`, for an unchanged selection unless the page clears the input.
  await expect(page.getByRole("status")).not.toContainText(first);
  const second = await uploadedKey(page, "Uploaded hello.txt (14 bytes) as", "txt");

  expect(second).not.toBe(first);
  expect(await storage.head(first)).toMatchObject({ data: { size: 14 }, error: null });
  expect(await storage.head(second)).toMatchObject({ data: { size: 14 }, error: null });
});
