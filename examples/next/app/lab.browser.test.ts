// The lab page in a real browser against a real S3 API, run by scripts/test-browser.sh (RustFS) or
// scripts/test-browser-live.ts (R2). The oracle is the request sequence the client's contract promises for each case
// (decisions S10 to S12, S14): the page must show exactly those requests, and never a signed URL. The progress rows
// read the job's snapshot through the page's bars (spec §6).
import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { expectNoSignedUrl, fileRows, requestRows, signIn, summaryValue } from "./lab-page";

const MIB = 1024 * 1024;
const TWENTY_MIB = 20_971_520;

/** Generates a test file in the page and uploads it, then waits for the line that says how the run ended. */
async function uploadGenerated(page: Page, size: string): Promise<void> {
  await page.getByRole("button", { name: size, exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  // Longer than expect's default 5 s, for a 20 MiB upload over a slow link; the test's own 30 s still bounds it.
  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
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

test("a PUT whose answer was dropped is sent again, and its 412 counts as stored", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("Drop the answer of the next bucket PUT").check();

  await uploadGenerated(page, "1 KiB");

  // The bucket stored the first PUT; the second carries If-None-Match: * like every single PUT, so it gets 412.
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT single", "network error", "answer dropped (the bucket sent 200)"],
    ["/sign", "200", "renewal"],
    ["PUT single", "412", "retry; already stored"],
    ["/complete", "200", ""],
  ]);
  await expect(page.getByRole("figure", { name: "Result" })).toContainText('"error": null');
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

// The order's promise is which file completes first, not the PUT sequence: a PUT that finds a free slot is never held
// back, so with smallest-first part 1 of the large file may go first, and a real retry on R2 adds an attempt.
for (const { order, first } of [
  { order: "smallest-first", first: "random-1-KiB.bin" },
  { order: "added", first: "random-20-MiB.bin" },
]) {
  test(`with one connection and order ${order}, ${first} completes first`, async ({ page }) => {
    await signIn(page);
    await page.getByLabel("Connections", { exact: true }).selectOption("1");
    await page.getByLabel("Order", { exact: true }).selectOption(order);
    // Every PUT waits a second, far longer than a /complete: the two files complete at least a second apart, and a poll
    // every 100 ms sees the first one done alone.
    await page.getByLabel(/Delay every bucket PUT by/).fill("1000");
    for (const size of ["20 MiB", "1 KiB"]) await page.getByRole("button", { name: size, exact: true }).click();
    await page.getByRole("button", { name: "Upload", exact: true }).click();

    let doneAtFirst: string[] = [];
    await expect
      .poll(
        async () => {
          doneAtFirst = await doneFiles(page);
          return doneAtFirst.length;
        },
        { intervals: [100], timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    expect(doneAtFirst).toEqual([first]);
    await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
    expect(await doneFiles(page)).toEqual(["random-20-MiB.bin", "random-1-KiB.bin"]);
    // One connection: never two PUTs in flight, retries included, however many attempts each PUT took.
    await expect(summaryValue(page, "Peak PUTs in flight")).toHaveText("1");
    // Four PUTs one after another, each delayed a second: the run took seconds, measured to its last answer.
    await expect(summaryValue(page, "Total time")).toHaveText(/^\d+\.\d s$/);
  });
}

test("a file whose part 2 kept failing is retried with its ticket, sending part 2 alone", async ({ page }) => {
  // Part 2's six attempts wait up to 0.5 + 1 + 2 + 4 + 8 s between them (M3-S9) before the file fails.
  test.setTimeout(60_000);
  await signIn(page);
  const fault = page.getByLabel("Fail every PUT of part 2 with a network error while ticked");
  await fault.check();
  await page.getByRole("button", { name: "20 MiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("failed with NETWORK_ERROR", { timeout: 30_000 });
  const failed = await requestRows(page);
  expect(failed).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "network error", "injected network error"],
    ["PUT part 3", "200", ""],
    ["/sign", "200", "renewal of part 2"],
    ...Array(5).fill(["PUT part 2", "network error", "retry; injected network error"]),
  ]);
  await fault.uncheck();

  await page.getByRole("button", { name: "Retry", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText(
    /^Started 9 PUTs \(at most 3 at a time\), 3 got an answer; part 2 was retried 6 times after a network error; renewed one URL through \/sign; completed after Retry, [\d.]+ m?s after Upload\.$/,
  );
  // The same ticket: no new /upload, and the parts that landed are not sent again.
  expect((await requestRows(page)).slice(failed.length)).toEqual([
    ["PUT part 2", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  expect(await fileRows(page)).toEqual([["random-20-MiB.bin", "done"]]);
  await expect(page.getByRole("figure", { name: "Result" })).toContainText('"error": null');
  await expectNoSignedUrl(page);
});

test("a file the bucket refused is retried with a new ticket", async ({ page }) => {
  await signIn(page);
  const fault = page.getByLabel("Refuse every bucket PUT with 400 while ticked");
  await fault.check();
  await page.getByRole("button", { name: "1 KiB", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("failed with UPLOAD_REJECTED");
  await fault.uncheck();

  await page.getByRole("button", { name: "Retry random-1-KiB.bin", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed after Retry");
  // UPLOAD_REJECTED needs a new ticket (M3-U31): a new /upload, and the file's PUT under its new key.
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT single", "400", "injected 400"],
    ["/upload", "200", "new ticket"],
    ["PUT single", "200", ""],
    ["/complete", "200", ""],
  ]);
  expect(await fileRows(page)).toEqual([["random-1-KiB.bin", "done"]]);
  await expect(page.getByRole("figure", { name: "Result" })).toContainText('"error": null');
  // The lab answered the 400 itself, so only the second PUT sent bytes.
  await expect(summaryValue(page, "Sent to the bucket")).toHaveText("1024 (1.0 KiB)");
});
