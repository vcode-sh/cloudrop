// The Vite app and the Hono API in a real browser against a real S3 API and Postgres, run by scripts/test-browser.sh
// (its third pass). Every row signs up a new user, so rows share no files or quota. The oracles are the bytes each row
// created, the bucket requests the page sent (their kind, never their URL: a presigned URL must not reach a log), the
// API's own answers, and `files.list`, which reads cloudrop's table.
import { writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

const MIB = 1024 * 1024;
const API = "http://localhost:5181";
const WEB_ORIGIN = "http://localhost:5173";
// A 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Labels such as "PUT part 2" for every bucket PUT the page sends, never the URL. */
function recordBucketPuts(page: Page): string[] {
  const labels: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT") return;
    const part = new URL(request.url()).searchParams.get("partNumber");
    labels.push(part ? `PUT part ${part}` : "PUT");
  });
  return labels;
}

/** Signs a new user up through the page's form and waits for the signed-in header. */
async function signUp(page: Page): Promise<string> {
  const email = `user-${crypto.randomUUID()}@example.com`;
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  return email;
}

/** The status line of the upload row of `name`. */
const rowStatus = (page: Page, name: string) =>
  page.getByRole("list", { name: "Uploads" }).getByRole("group", { name, exact: true }).getByRole("status");

/** The "Your files" table's rows as [name, route, size]. */
async function listedFiles(page: Page): Promise<string[][]> {
  // The header row has column headers, not cells, so it reads as an empty row and is left out.
  const rows = await page.getByRole("table", { name: "Your files" }).getByRole("row").all();
  const cells = await Promise.all(rows.map((row) => row.getByRole("cell").allTextContents()));
  return cells.filter((row) => row.length > 0).map((row) => row.slice(0, 3));
}

/** 0, 1, …, 250, 0, 1, …: a part sent at the wrong offset reads back different. */
function patternBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index++) bytes[index] = index % 251;
  return bytes;
}

/** A file on disk, so a reload can pick the same file with the same lastModified (and above Playwright's 50 MB). */
async function fileOnDisk(testInfo: TestInfo, name: string, size: number): Promise<string> {
  const path = testInfo.outputPath(name);
  await writeFile(path, patternBytes(size));
  return path;
}

test("cloudrop answers its own preflight through the app's global CORS middleware", async ({ request }) => {
  const preflight = await request.fetch(`${API}/api/cloudrop/upload`, {
    method: "OPTIONS",
    headers: {
      origin: WEB_ORIGIN,
      "access-control-request-method": "POST",
      // A header the app's own CORS list leaves out: a bearer token, as a client with its own fetch sends.
      "access-control-request-headers": "content-type,authorization",
    },
  });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()).toMatchObject({
    "access-control-allow-origin": WEB_ORIGIN,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type,authorization",
    "cache-control": "no-store",
  });
});

test("a form posted to an oRPC procedure from another origin of the site is refused, though it carries the session", async ({
  page,
}) => {
  await signUp(page);
  // What a page on another localhost port, or a sibling subdomain in production, can make the browser send without a
  // preflight: a multipart form, with the API's SameSite=Lax session cookie, which page.request shares.
  const answer = await page.request.post(`${API}/rpc/files/list`, {
    headers: { origin: "http://localhost:5174" },
    multipart: { data: JSON.stringify({ json: null }) },
  });

  expect(answer.status()).toBe(403);
  expect(await answer.json()).toMatchObject({ json: { code: "CSRF_TOKEN_MISMATCH" } });
});

test("signed out, an upload is refused with UNAUTHORIZED and the route's message, before any byte is sent", async ({
  page,
}) => {
  const puts = recordBucketPuts(page);
  await page.goto("/");
  await page
    .getByLabel("Choose attachments")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });

  await expect(rowStatus(page, "notes.txt")).toHaveText("UNAUTHORIZED: Sign in to upload files.");
  expect(puts).toEqual([]);
});

test("a new user uploads an avatar in one PUT, and the page shows it from the bucket", async ({ page }) => {
  const puts = recordBucketPuts(page);
  await signUp(page);
  await expect(page.getByRole("img", { name: "No avatar yet" })).toBeVisible();

  await page.getByLabel("Choose an avatar").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });

  const avatar = page.getByRole("img", { name: "Your avatar" });
  await expect(avatar).toBeVisible();
  // Decoded from the signed URL files.avatar returned: the stored object is the image that was sent.
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  expect(puts).toEqual(["PUT"]);
  expect(await listedFiles(page)).toEqual([["me.png", "avatar", `${PNG.length} bytes`]]);
});

test("several attachments, one of them in three parts, are listed by files.list, and one is deleted", async ({
  page,
}) => {
  const puts = recordBucketPuts(page);
  await signUp(page);

  await page.getByLabel("Choose attachments").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello cloudrop") },
    { name: "logo.png", mimeType: "image/png", buffer: PNG },
    { name: "big.bin", mimeType: "application/octet-stream", buffer: patternBytes(20 * MIB) },
  ]);

  await expect(rowStatus(page, "big.bin")).toHaveText("Uploaded, 20.0 MB", { timeout: 20_000 });
  await expect(rowStatus(page, "notes.txt")).toHaveText("Uploaded, 14 bytes");
  await expect(rowStatus(page, "logo.png")).toHaveText(`Uploaded, ${PNG.length} bytes`);
  expect(puts.toSorted()).toEqual(["PUT", "PUT", "PUT part 1", "PUT part 2", "PUT part 3"]);
  await expect
    .poll(() => listedFiles(page).then((rows) => rows.toSorted()))
    .toEqual([
      ["big.bin", "attachments", "20.0 MB"],
      ["logo.png", "attachments", `${PNG.length} bytes`],
      ["notes.txt", "attachments", "14 bytes"],
    ]);

  await page.getByRole("button", { name: "Delete notes.txt" }).click();
  await expect
    .poll(() => listedFiles(page).then((rows) => rows.map(([name]) => name).toSorted()))
    .toEqual(["big.bin", "logo.png"]);
});

test("a file larger than the room left in the quota is refused with QUOTA_EXCEEDED before any byte is sent", async ({
  page,
}, testInfo) => {
  // The lane runs the API with UPLOAD_QUOTA_MB=50, and a new user has used none of it.
  const path = await fileOnDisk(testInfo, "too-big.bin", 51 * MIB);
  const puts = recordBucketPuts(page);
  await signUp(page);

  await page.getByLabel("Choose attachments").setInputFiles(path);

  await expect(rowStatus(page, "too-big.bin")).toHaveText(
    "QUOTA_EXCEEDED: Your storage limit is reached. Delete some files or ask for more space, then try again.",
  );
  expect(puts).toEqual([]);
  await expect(page.getByText("No files yet.")).toBeVisible();
});

test("a multipart upload interrupted by a reload resumes from the parts the bucket has", async ({ page }, testInfo) => {
  const path = await fileOnDisk(testInfo, "resume.bin", 20 * MIB);
  await signUp(page);
  // Parts 2 and 3 never reach the bucket before the reload; part 1 does.
  await page.route(/[?&]partNumber=[23](&|$)/, () => {});
  const firstPart = page.waitForResponse((response) => /[?&]partNumber=1(&|$)/.test(response.url()) && response.ok());
  await page.getByLabel("Choose attachments").setInputFiles(path);
  await firstPart;

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const unfinished = page.getByRole("list", { name: "Unfinished uploads" });
  await expect(unfinished.getByRole("listitem")).toContainText(["resume.bin, 20.0 MB"]);
  const puts = recordBucketPuts(page);
  await page.getByLabel("Pick resume.bin again").setInputFiles(path);

  await expect(rowStatus(page, "resume.bin")).toHaveText("Uploaded, 20.0 MB", { timeout: 20_000 });
  expect(puts.toSorted()).toEqual(["PUT part 2", "PUT part 3"]);
  await expect(unfinished).toHaveCount(0);
  await expect.poll(() => listedFiles(page)).toEqual([["resume.bin", "attachments", "20.0 MB"]]);
});
