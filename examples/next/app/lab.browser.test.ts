// The lab page in a real browser against a real S3 API, run by scripts/test-browser.sh (RustFS) or
// scripts/test-browser-live.ts (R2). The oracle is the request sequence the client's contract promises for each case
// (decisions S10 to S12, S14): the page must show exactly those requests, and never a signed URL. The progress rows
// read the job's snapshot through the page's bars (spec §6).
import { type CDPSession, expect, type Page, test } from "@playwright/test";

const MIB = 1024 * 1024;
const TWENTY_MIB = 20_971_520;

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

/** Each file of the job as [name, status], in the order the page shows them. */
function fileRows(page: Page): Promise<[name: string, status: string][]> {
  return page
    .getByRole("table", { name: "Files" })
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")))
    .then((rows) => rows.map((cells): [string, string] => [cells[0] ?? "", cells[5] ?? ""]));
}

/** Chromium's network at 4 MiB/s up, so a 20 MiB file takes about five seconds and its bar has time to move. */
const THROTTLED = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 4 * MIB };

/** Throttles uploads; the session it returns changes the network conditions later. */
async function throttleUploads(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", THROTTLED);
  return cdp;
}

/** The value of the file's bar every 100 ms until the run's status line says how it ended, and once more after. */
async function sampleUntilEnded(page: Page, name: string): Promise<number[]> {
  const bar = page.getByRole("progressbar", { name: `Progress of ${name}` });
  await expect(bar).toBeVisible();
  const samples: number[] = [];
  const sample = async () => samples.push(await bar.evaluate((element: HTMLProgressElement) => element.value));
  await expect
    .poll(
      async () => {
        await sample();
        return page.getByRole("status").textContent();
      },
      { intervals: [100], timeout: 20_000 },
    )
    .toContain("completed");
  await sample();
  // Kept with the test's result, as evidence that the bar moved.
  test.info().annotations.push({ type: "progress samples", description: samples.join(" ") });
  return samples;
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

test("progress rises while a file uploads and ends at its size", async ({ page }) => {
  await signIn(page);
  await throttleUploads(page);
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  const samples = await sampleUntilEnded(page, "random-20-MiB.bin");

  // Never decreasing: sorting changes nothing.
  expect(samples).toEqual(samples.toSorted((a, b) => a - b));
  expect(samples.filter((value) => value > 0 && value < TWENTY_MIB).length).toBeGreaterThanOrEqual(3);
  expect(samples.at(-1)).toBe(TWENTY_MIB);
});

test("with PUTs sent through fetch, the bar moves a part at a time", async ({ page }) => {
  await signIn(page);
  await throttleUploads(page);
  await page.getByLabel("Send PUTs with fetch (no progress while sending)").check();
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();

  const samples = await sampleUntilEnded(page, "random-20-MiB.bin");

  // Parts of 8, 8 and 4 MiB count only once stored, in any order: every value is a multiple of 4 MiB.
  expect(samples.filter((value) => value % (4 * MIB) !== 0)).toEqual([]);
  expect(samples.at(-1)).toBe(TWENTY_MIB);
  // The lab's fetch, passed as the client's option, saw the bucket PUTs.
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/complete", "200", ""],
  ]);
});

test("a paused multipart file resumes and completes", async ({ page }) => {
  await signIn(page);
  // Long enough that all three parts still wait inside the lab's XMLHttpRequest when Pause is pressed.
  await page.getByLabel(/Delay every bucket PUT by/).fill("2000");
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("cell", { name: "PUT part 3", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => fileRows(page)).toEqual([["random-20-MiB.bin", "paused"]]);
  await page.getByLabel(/Delay every bucket PUT by/).fill("0");
  await page.getByRole("button", { name: "Resume", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText(
    /^Started 6 PUTs \(at most 3 at a time\), 3 got an answer; sent 3 PUTs again after a pause; completed in [\d.]+ m?s at [\d.]+ MiB\/s\.$/,
    { timeout: 20_000 },
  );
  // Each part stored once, after the attempts the pause cancelled.
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "cancelled", "delayed 2000 ms"],
    ["PUT part 2", "cancelled", "delayed 2000 ms"],
    ["PUT part 3", "cancelled", "delayed 2000 ms"],
    ["PUT part 1", "200", "resumed"],
    ["PUT part 2", "200", "resumed"],
    ["PUT part 3", "200", "resumed"],
    ["/complete", "200", ""],
  ]);
  expect(await fileRows(page)).toEqual([["random-20-MiB.bin", "done"]]);
  await expect(summaryValue(page, "Sent to the bucket")).toHaveText("20971520 (20.0 MiB)");
  await expectNoSignedUrl(page);
});

test("three files in one job", async ({ page }) => {
  await signIn(page);
  for (const size of ["1 KiB", "5 MiB", "20 MiB"]) await page.getByRole("button", { name: size, exact: true }).click();

  await page.getByRole("button", { name: "Upload", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  const rows = await requestRows(page);
  // One /upload for the job; the files' requests interleave, so their order is not the client's promise.
  expect(rows.map(([kind]) => kind).toSorted()).toEqual([
    "/complete",
    "/complete",
    "/complete",
    "/upload",
    "PUT part 1",
    "PUT part 2",
    "PUT part 3",
    "PUT single",
    "PUT single",
  ]);
  // Two files each sending "PUT single" is not a retry.
  expect(rows.filter(([, status, note]) => status !== "200" || note !== "")).toEqual([]);
  expect(await fileRows(page)).toEqual([
    ["random-1-KiB.bin", "done"],
    ["random-5-MiB.bin", "done"],
    ["random-20-MiB.bin", "done"],
  ]);
  await expect(summaryValue(page, "Size of the 3 files")).toHaveText("26215424 (25.0 MiB)");
  await expectNoSignedUrl(page);
});

test("going offline pauses an upload and coming back online completes it", async ({ page }) => {
  await signIn(page);
  const cdp = await throttleUploads(page);
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const bar = page.getByRole("progressbar", { name: "Progress of random-20-MiB.bin" });
  await expect.poll(() => bar.evaluate((element: HTMLProgressElement) => element.value)).toBeGreaterThan(0);

  // Chromium's emulated offline sets navigator.onLine and fires the page's `offline` event, which the client hears.
  await cdp.send("Network.emulateNetworkConditions", { ...THROTTLED, offline: true });

  await expect.poll(() => fileRows(page)).toEqual([["random-20-MiB.bin", "paused"]]);
  await expect(summaryValue(page, "PUTs in flight")).toHaveText("0");
  await cdp.send("Network.emulateNetworkConditions", { ...THROTTLED, uploadThroughput: -1 });
  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  expect(await fileRows(page)).toEqual([["random-20-MiB.bin", "done"]]);
  // The client's pause cancelled the PUTs in flight; online sent each part again, and each was stored once.
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "cancelled", ""],
    ["PUT part 2", "cancelled", ""],
    ["PUT part 3", "cancelled", ""],
    ["PUT part 1", "200", "resumed"],
    ["PUT part 2", "200", "resumed"],
    ["PUT part 3", "200", "resumed"],
    ["/complete", "200", ""],
  ]);
  await expect(summaryValue(page, "Sent to the bucket")).toHaveText("20971520 (20.0 MiB)");
});

/** The names of the files the page shows as done, in the order they were added. */
const doneFiles = async (page: Page): Promise<string[]> =>
  (await fileRows(page)).filter(([, status]) => status === "done").map(([name]) => name);

for (const { order, puts, first } of [
  {
    order: "smallest-first",
    puts: ["PUT part 1", "PUT single", "PUT part 2", "PUT part 3"],
    first: "random-1-KiB.bin",
  },
  { order: "added", puts: ["PUT part 1", "PUT part 2", "PUT part 3", "PUT single"], first: "random-20-MiB.bin" },
]) {
  test(`with one connection and order ${order}, ${first} completes first`, async ({ page }) => {
    await signIn(page);
    await page.getByLabel("Connections", { exact: true }).selectOption("1");
    await page.getByLabel("Order", { exact: true }).selectOption(order);
    // Every PUT waits a second, far longer than a /complete: the file whose last PUT is answered first completes first.
    await page.getByLabel(/Delay every bucket PUT by/).fill("1000");
    for (const size of ["20 MiB", "1 KiB"]) await page.getByRole("button", { name: size, exact: true }).click();
    await page.getByRole("button", { name: "Upload", exact: true }).click();

    await expect.poll(() => doneFiles(page), { timeout: 20_000 }).not.toEqual([]);
    expect(await doneFiles(page)).toEqual([first]);
    await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
    const rows = await requestRows(page);
    expect(rows.map(([kind]) => kind).filter((kind) => kind?.startsWith("PUT"))).toEqual(puts);
    await expect(summaryValue(page, "Peak PUTs in flight")).toHaveText("1");
  });
}
