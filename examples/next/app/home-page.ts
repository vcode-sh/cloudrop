// Helpers the home page's browser tests share (upload.browser.test.ts and upload.store.browser.test.ts). They find
// what a person sees by role and name, and fault the bucket through Playwright's routing, which works on R2 too.
import { expect, type Locator, type Page, type Route } from "@playwright/test";

export const ORIGIN = "http://localhost:5173";
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

const prefix = process.env.CLOUDROP_EXAMPLE_PREFIX;
if (!prefix)
  throw new Error(
    "CLOUDROP_EXAMPLE_PREFIX is not set. Run this test through `bun run test:browser` or `bun run test:browser:live`.",
  );

/** Signs in through the home page's form; the server answers with a redirect that reloads the page. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Sign in as the demo user" }).click(),
  ]);
}

/** The rows of the upload list for files named `name`, in start order. */
export const fileRows = (page: Page, name: string): Locator =>
  page.getByRole("list", { name: "Uploads", exact: true }).getByRole("listitem").filter({ hasText: name });

/** The unfinished-uploads panel's list. */
export const unfinishedList = (page: Page): Locator => page.getByRole("list", { name: "Unfinished uploads" });

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Waits until `row` says `${size}, stored as <prefix>/demo/<ulid>.<extension>` and returns the key. */
export async function storedKey(row: Locator, size: string, extension: string): Promise<string> {
  const pattern = new RegExp(`${literal(size)}, stored as (${literal(`${prefix}/demo/`)}${ULID}\\.${extension})$`);
  // Longer than expect's default 5 s, for a 20 MiB upload over a slow link; the test's own 30 s still bounds it.
  await expect(row).toContainText(pattern, { timeout: 20_000 });
  const key = pattern.exec((await row.textContent()) ?? "")?.[1];
  if (!key) throw new Error("The row names no stored key.");
  return key;
}

/** Answers the page's bucket requests with `handle`; requests to the example itself pass through. */
export const routeBucket = (page: Page, handle: (route: Route) => unknown) =>
  page.route((url) => url.origin !== ORIGIN, handle);

const partNumber = (url: string) => new URL(url).searchParams.get("partNumber");

/**
 * Uploads the on-disk files at `paths` (each over 16 MiB, so at least three parts) until each has part 1 in the bucket,
 * holding every other part, then reloads: each upload is left unfinished, for the unfinished-uploads panel to list.
 */
export async function leaveUnfinished(page: Page, paths: readonly string[]): Promise<void> {
  await routeBucket(page, (route) => (partNumber(route.request().url()) === "1" ? route.continue() : undefined));
  let partOnes = 0;
  const counted = (response: { url(): string; status(): number }) => {
    if (partNumber(response.url()) === "1" && response.status() === 200) partOnes += 1;
  };
  page.on("response", counted);
  await page.getByLabel("Files to upload").setInputFiles([...paths]);
  await expect.poll(() => partOnes, { timeout: 20_000 }).toBe(paths.length);
  page.off("response", counted);
  await page.reload();
  // After the reload: the held PUTs died with the old page.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(unfinishedList(page).getByRole("listitem")).toHaveCount(paths.length);
}
