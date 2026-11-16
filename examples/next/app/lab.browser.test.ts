// The lab page in a real browser against a real S3 API, run by scripts/test-browser.sh (RustFS) or
// scripts/test-browser-live.ts (R2). The oracle is the request sequence the client's contract promises for each case
// (decisions S10 to S12, S14): the page must show exactly those requests, and never a signed URL.
import { expect, type Page, test } from "@playwright/test";

/** Signs in through the lab's form; the server answers with a redirect back to /lab. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/lab");
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Sign in as the demo user" }).click(),
  ]);
}

/** Generates a test file in the page and uploads it, then waits for the line that says how the run ended. */
async function uploadGenerated(page: Page, size: string): Promise<void> {
  await page.getByRole("button", { name: size, exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  // Longer than expect's default 5 s, for a 20 MiB upload over a slow link; the test's own 30 s still bounds it.
  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
}

/** Each logged request as [kind, status, note], in the order the page shows them. */
function requestRows(page: Page): Promise<string[][]> {
  return page
    .getByRole("table", { name: "Requests" })
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => [...row.querySelectorAll("td")].slice(0, 3).map((cell) => cell.textContent ?? "")),
    );
}

const summaryValue = (page: Page, term: string) => page.locator(`dt:text-is("${term}") + dd`);

/**
 * No signed URL on the page: no signature parameter, and nothing after the bucket host that could be a query. The host
 * comes from the server's settings (/api/lab-info), not from what the page recorded of the requests.
 */
async function expectNoSignedUrl(page: Page): Promise<void> {
  const host = (await summaryValue(page, "Storage host").textContent()) ?? "";
  expect(host).toMatch(/^[\w.…-]+(?::\d+)?$/);
  const text = (await page.locator("body").textContent()) ?? "";
  expect(text).not.toContain("X-Amz-Signature");
  expect(text).not.toMatch(new RegExp(`${host.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\S*\\?`));
}

test("the lab shows a 20 MiB upload as three parts", async ({ page }) => {
  await signIn(page);

  await uploadGenerated(page, "20 MiB");

  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/complete", "200", ""],
  ]);
  await expect(page.getByRole("status")).toHaveText(
    /^Started 3 PUTs \(at most 3 at a time\), all got an answer; completed in [\d.]+ m?s at [\d.]+ MiB\/s\.$/,
  );
  await expect(summaryValue(page, "File size")).toHaveText("20971520 (20.0 MiB)");
  await expect(summaryValue(page, "Sent to the bucket")).toHaveText("20971520 (20.0 MiB)");
  await expectNoSignedUrl(page);
});

test("a dropped bucket PUT is renewed and retried", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Fail the next bucket PUT with a network error").check();

  await uploadGenerated(page, "1 KiB");

  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT single", "network error", "injected network error"],
    ["/sign", "200", "renewal"],
    ["PUT single", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  await expect(page.getByRole("figure", { name: "Result" })).toContainText('"error": null');
  // The PUT that failed sent nothing the bucket answered; a 1 KiB rate would measure round trips, not bandwidth.
  await expect(page.getByRole("status")).toHaveText(
    /^Started 2 PUTs, 1 got an answer; the PUT was retried once after a network error; renewed one URL through \/sign; completed in [\d.]+ m?s\.$/,
  );
  await expect(summaryValue(page, "Sent to the bucket")).toHaveText("1024 (1.0 KiB)");
  await expectNoSignedUrl(page);
});

test("a cancel while parts wait sends nothing to the bucket", async ({ page }) => {
  await signIn(page);
  // Long enough that all three parts are still waiting inside the lab's fetch when Cancel is pressed.
  await page.getByLabel(/Delay every bucket PUT by/).fill("3000");
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("cell", { name: "PUT part 3", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText(
    /^Started 3 PUTs \(at most 3 at a time\), none got an answer; cancelled after [\d.]+ m?s; the client told the server with \/abort\.$/,
  );
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "cancelled", "delayed 3000 ms"],
    ["PUT part 2", "cancelled", "delayed 3000 ms"],
    ["PUT part 3", "cancelled", "delayed 3000 ms"],
    ["/abort", "200", ""],
  ]);
  await expect(summaryValue(page, "Sent to the bucket")).toHaveText("0 bytes");
  await expectNoSignedUrl(page);
});
