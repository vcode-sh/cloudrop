// The Vite app and the Hono API in a real browser against a real S3 API and Postgres, run by scripts/test-browser.sh
// (its third pass). Every row signs up a new user, so rows share no files or quota. The oracles are the bytes each row
// created, the bucket requests the page sent (their kind, never their URL: a presigned URL must not reach a log), the
// API's own answers, `files.list`, which reads cloudrop's table, and that table read straight from the database.
import { writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import pg from "pg";

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

/** Signs an existing user in through the page's form and waits for the signed-in header. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

/** Starts a multipart upload of `path` whose part 1 reaches the bucket and whose later parts are held for good. */
async function uploadPartOneOnly(page: Page, path: string): Promise<void> {
  await page.route(/[?&]partNumber=[23](&|$)/, () => {});
  const firstPart = page.waitForResponse((response) => /[?&]partNumber=1(&|$)/.test(response.url()) && response.ok());
  await page.getByLabel("Choose attachments").setInputFiles(path);
  await firstPart;
}

/** The second line of the upload row of `name`: its state, which only the route's status line announces. */
const rowStatus = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "Uploads" })
    .getByRole("group", { name, exact: true })
    .locator('[data-slot="attachment-description"]');

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

/** The status of each of this user's rows in cloudrop's table, by file name, read from the API's database. */
async function storedStatuses(email: string): Promise<Record<string, string>> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Run this test through `bun run test:browser`.");
  const client = new pg.Client(url);
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string; status: string }>(
      'SELECT f.name, f.status FROM cloudrop_files f JOIN "user" u ON u.id = f.owner WHERE u.email = $1',
      [email],
    );
    return Object.fromEntries(rows.map(({ name, status }) => [name, status]));
  } finally {
    await client.end();
  }
}

test("cloudrop answers its own preflight through the app's global CORS middleware", async ({ request }) => {
  const preflight = await request.fetch(`${API}/api/cloudrop/upload`, {
    method: "OPTIONS",
    headers: {
      origin: WEB_ORIGIN,
      "access-control-request-method": "POST",
      // A header the app's own CORS list leaves out: a bearer token, as the client's headers option sends.
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

  await page.reload();
  // After the reload: the held PUTs died with the old page. Unrouted before it, they could still reach the bucket.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const unfinished = page.getByRole("list", { name: "Unfinished uploads" });
  await expect(unfinished.getByRole("listitem")).toContainText(["resume.bin, 20.0 MB"]);
  const puts = recordBucketPuts(page);
  await page.getByLabel("Pick resume.bin again").setInputFiles(path);

  await expect(rowStatus(page, "resume.bin")).toHaveText("Uploaded, 20.0 MB", { timeout: 20_000 });
  expect(puts.toSorted()).toEqual(["PUT part 2", "PUT part 3"]);
  await expect(unfinished).toHaveCount(0);
  await expect.poll(() => listedFiles(page)).toEqual([["resume.bin", "attachments", "20.0 MB"]]);
});

test("of two unfinished uploads, Discard aborts one in the store and the other still resumes", async ({
  page,
}, testInfo) => {
  const kept = await fileOnDisk(testInfo, "kept.bin", 20 * MIB);
  const dropped = await fileOnDisk(testInfo, "dropped.bin", 20 * MIB);
  const email = await signUp(page);
  // Each file's part 1 reaches the bucket before the reload; every later part is held.
  await page.route(/[?&]partNumber=[23](&|$)/, () => {});
  let partOnes = 0;
  page.on("response", (response) => {
    if (/[?&]partNumber=1(&|$)/.test(response.url()) && response.ok()) partOnes += 1;
  });
  await page.getByLabel("Choose attachments").setInputFiles([kept, dropped]);
  await expect.poll(() => partOnes, { timeout: 20_000 }).toBe(2);

  await page.reload();
  // After the reload: the held PUTs died with the old page. Unrouted before it, they could still reach the bucket.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const unfinished = page.getByRole("list", { name: "Unfinished uploads" });
  await expect(unfinished.getByRole("listitem")).toHaveCount(2);
  await unfinished.getByRole("button", { name: "Discard dropped.bin" }).focus();
  await page.keyboard.press("Enter");

  // The discarded row unmounts; focus is on the row that stays.
  await expect(unfinished.getByRole("listitem")).toHaveCount(1);
  await expect(unfinished.getByRole("listitem")).toContainText("kept.bin, 20.0 MB");
  await expect(unfinished.getByRole("button", { name: "Discard kept.bin" })).toBeFocused();
  await expect.poll(() => storedStatuses(email)).toEqual({ "dropped.bin": "aborted", "kept.bin": "pending" });

  const puts = recordBucketPuts(page);
  await page.getByLabel("Pick kept.bin again").setInputFiles(kept);
  await expect(rowStatus(page, "kept.bin")).toHaveText("Uploaded, 20.0 MB", { timeout: 20_000 });
  expect(puts.toSorted()).toEqual(["PUT part 2", "PUT part 3"]);
  await expect(unfinished).toHaveCount(0);
  await expect.poll(() => listedFiles(page)).toEqual([["kept.bin", "attachments", "20.0 MB"]]);
  expect(await storedStatuses(email)).toEqual({ "dropped.bin": "aborted", "kept.bin": "completed" });
});

test("the next user of the browser never lists the last one's unfinished upload, which that user still can resume", async ({
  page,
}, testInfo) => {
  const theirs = await fileOnDisk(testInfo, "theirs.bin", 10 * MIB);
  const mine = await fileOnDisk(testInfo, "mine.bin", 10 * MIB);
  const first = await signUp(page);
  await uploadPartOneOnly(page, theirs);
  // The session ends without Sign out, so nothing forgets the record: a closed tab, or a session that expired.
  await page.context().clearCookies();

  // The second user's own unfinished upload is listed, so the list was read, and the first user's is not in it.
  await signUp(page);
  await uploadPartOneOnly(page, mine);
  await page.reload();
  // After the reload: the held PUTs died with the old page. Unrouted before it, they could still reach the bucket.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const unfinished = page.getByRole("list", { name: "Unfinished uploads" }).getByRole("listitem");
  // Exactly one row, which begins with the name and size and goes on with its Resume label.
  await expect(unfinished).toHaveText([/^mine\.bin, 10\.0 MB/]);

  await page.context().clearCookies();
  await signIn(page, first);
  await expect(unfinished).toHaveText([/^theirs\.bin, 10\.0 MB/]);
});

test("Sign out during a multipart upload ends its row as aborted", async ({ page }, testInfo) => {
  const path = await fileOnDisk(testInfo, "left.bin", 20 * MIB);
  const email = await signUp(page);
  await uploadPartOneOnly(page, path);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  // After the reload: the held PUTs died with the old page.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // Forgetting alone would leave the row pending, holding its bytes against the quota until a sweep.
  await expect.poll(() => storedStatuses(email)).toEqual({ "left.bin": "aborted" });
});
