// Stalls, slow parts and interruptions mid-body, through the chaos proxy that scripts/test-browser.sh puts between the
// example and RustFS (chaos design §4 rows 10, 11, 15 and 16). The oracles: what reached the bucket (the proxy's log),
// the requests the lab's table shows, and the object read back through the example's own storage. Playwright's clock
// drives the page's timers, the client's 30 s stall watchdog among them, while every XHR stays real (decision M3-K3).
import type { Page } from "@playwright/test";
import { bucketPuts, type Chaos, expect, test } from "./chaos-control";
import {
  barValue,
  chooseOnDisk,
  expectStoredAsResult,
  fileRows,
  keepSamples,
  onDiskFile,
  requestRows,
  sampleProgress,
  signIn,
  throttleUploads,
  uploadsAt,
} from "./lab-page";

const MIB = 1024 * 1024;
const TWENTY_MIB = 20 * MIB;
const STALL_MS = 30_000;

/** Uploads `path` and waits until parts 2 and 3 are stored, with part 1 still on its way. */
async function uploadUntilPartOneAlone(page: Page, chaos: Chaos, path: string): Promise<void> {
  await chooseOnDisk(page, path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect
    .poll(
      async () =>
        bucketPuts(await chaos.log())
          .filter(([label]) => label !== "PUT part 1")
          .toSorted(),
      {
        timeout: 20_000,
      },
    )
    .toEqual([
      ["PUT part 2", 200],
      ["PUT part 3", 200],
    ]);
}

/** Part 1's attempts as the bucket saw them: the outcome and the body bytes that reached it. */
const partOneAttempts = async (chaos: Chaos) =>
  (await chaos.log())
    .filter((entry) => entry.label === "PUT part 1")
    .map(({ outcome, bytesIn }) => ({ outcome, bytesIn }));

/**
 * Throttles part 1's first attempt at the proxy, which then takes 4 s; its resend is not slowed. Chromium hands about
 * 6 MiB of it to the kernel at once, and the proxy hears the client close only after reading those bytes (the close
 * comes after them on the connection), so a cut attempt ends in the log about 3 s later.
 */
const SLOW_PART_ONE = {
  match: { kind: "presigned", operation: "UploadPart", part: 1 },
  fault: { kind: "throttle", bytesPerSecond: 2 * MIB },
} as const;

/** Waits until part 1's first attempt has ended in the proxy's log, closed by the client before its last byte. */
async function partOneCut(chaos: Chaos): Promise<void> {
  await expect.poll(async () => (await partOneAttempts(chaos))[0]?.outcome, { timeout: 10_000 }).toBe("aborted");
  expect((await partOneAttempts(chaos))[0]?.bytesIn).toBeLessThan(8 * MIB);
}

test("a black-holed part stalls after 30 s without progress, is renewed and sent again", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await chaos.set([{ match: { kind: "presigned", operation: "UploadPart", part: 1 }, fault: { kind: "blackhole" } }]);
  await page.clock.install();
  await signIn(page);
  await uploadUntilPartOneAlone(page, chaos, file.path);
  // The proxy reads the whole held body, so the bar reaches the file's size once the watchdog's last re-arm has run.
  await expect.poll(() => barValue(page, file.name)).toBe(TWENTY_MIB);

  // Not before its time: 25 s on, part 1 is still held. The 5 s left cover the real time since its last progress.
  await page.clock.fastForward(STALL_MS - 5000);
  // An absence: an abort would reach the proxy within milliseconds of the jump.
  await page.waitForTimeout(300);
  expect(await partOneAttempts(chaos)).toEqual([{ outcome: "held", bytesIn: 8 * MIB }]);
  const jumped = Date.now();
  await page.clock.fastForward(5000);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 10_000 });
  // The stall came from the clock: far less than 30 s of real time passed.
  expect(Date.now() - jumped).toBeLessThan(10_000);
  // The client closed part 1's connection, renewed its URL and sent it again (M3-U27, S10).
  expect(await partOneAttempts(chaos)).toEqual([
    { outcome: "aborted", bytesIn: 8 * MIB },
    { outcome: 200, bytesIn: 8 * MIB },
  ]);
  // Nobody paused or cancelled, so the lab shows the client's own abort as a stall and the next attempt as its retry.
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "stalled", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/sign", "200", "renewal of part 1"],
    ["PUT part 1", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  await expect(page.getByRole("status")).toHaveText(
    /^Started 4 PUTs \(at most 3 at a time\), 3 got an answer; part 1 was retried once after a stall; renewed one URL through \/sign; completed in [\d.]+ m?s at [\d.]+ MiB\/s\.$/,
  );
  expect(await fileRows(page)).toEqual([[file.name, "done"]]);
  await expectStoredAsResult(page, file.path);
  expect(await chaos.uploadsLeft()).toEqual([]);
});

test("a part that keeps sending is never stalled, however long it takes", async ({ page, chaos }, testInfo) => {
  // Parts of 8 and 1 MiB. Chromium's own throttle, not the proxy's: on loopback the kernel takes about 6 MiB of a part
  // at once, so a part slowed at the proxy reports its progress in a few jumps seconds apart (measured 2026-11-17).
  const file = await onDiskFile(testInfo, 9);
  await page.clock.install();
  await signIn(page);
  await throttleUploads(page, MIB);
  await chooseOnDisk(page, file.path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect.poll(() => barValue(page, file.name)).toBeGreaterThan(0);

  // 40 s of the page's time while part 1 sends: had its progress not re-armed the watchdog, it would fire at 30 s.
  const samples: number[] = [];
  for (let jump = 0; jump < 8; jump++) {
    await page.clock.fastForward(5000);
    await page.waitForTimeout(400);
    samples.push(await barValue(page, file.name));
  }

  keepSamples(samples);
  // The bar moved between every two jumps, and part 1 was still sending at the last one.
  expect(samples.filter((value, index) => index > 0 && value <= (samples[index - 1] ?? 0))).toEqual([]);
  expect(samples.at(-1)).toBeLessThan(9 * MIB);
  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  expect(bucketPuts(await chaos.log()).toSorted()).toEqual([
    ["PUT part 1", 200],
    ["PUT part 2", 200],
  ]);
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "200", ""],
    ["/complete", "200", ""],
  ]);
  await expectStoredAsResult(page, file.path);
  expect(await chaos.uploadsLeft()).toEqual([]);
});

test("offline mid-body pauses the file; online sends only the interrupted part again", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await chaos.set([SLOW_PART_ONE]);
  await signIn(page);
  const cdp = await throttleUploads(page, -1);
  await uploadUntilPartOneAlone(page, chaos, file.path);

  // Chromium's emulated offline fires the page's `offline` event, which pauses the client (M3-U28).
  await cdp.send("Network.emulateNetworkConditions", uploadsAt(-1, true));

  await expect.poll(() => fileRows(page)).toEqual([[file.name, "paused"]]);
  // The cut takes longer than the spec's 2 s offline. Paused all along: the attempt that was cut is all there is.
  await partOneCut(chaos);
  expect(await partOneAttempts(chaos)).toHaveLength(1);
  expect(await fileRows(page)).toEqual([[file.name, "paused"]]);
  await cdp.send("Network.emulateNetworkConditions", uploadsAt(-1));

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  expect((await partOneAttempts(chaos)).slice(1)).toEqual([{ outcome: 200, bytesIn: 8 * MIB }]);
  expect(
    bucketPuts(await chaos.log())
      .filter(([label]) => label !== "PUT part 1")
      .toSorted(),
  ).toEqual([
    ["PUT part 2", 200],
    ["PUT part 3", 200],
  ]);
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "cancelled", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["PUT part 1", "200", "resumed"],
    ["/complete", "200", ""],
  ]);
  await expectStoredAsResult(page, file.path);
  expect(await chaos.uploadsLeft()).toEqual([]);
});

test("a pause mid-body sends the interrupted part twice, the others once, and the bar never goes back", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await chaos.set([SLOW_PART_ONE]);
  await signIn(page);
  await uploadUntilPartOneAlone(page, chaos, file.path);
  const stopSampling = sampleProgress(page, file.name);
  // Part 1 has reported bytes: a resend that started the bar from its own zero again would show as a drop.
  await expect.poll(() => barValue(page, file.name)).toBeGreaterThan(12 * MIB);

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => fileRows(page)).toEqual([[file.name, "paused"]]);
  // The resend climbs at 2 MiB/s, slow enough for the samples to catch the bar going back if it did.
  await throttleUploads(page, 2 * MIB);
  await page.getByRole("button", { name: "Resume", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  const samples = await stopSampling();
  expect(samples).toEqual(samples.toSorted((a, b) => a - b));
  expect(samples.at(-1)).toBe(TWENTY_MIB);
  await partOneCut(chaos);
  expect((await partOneAttempts(chaos)).slice(1)).toEqual([{ outcome: 200, bytesIn: 8 * MIB }]);
  expect(
    bucketPuts(await chaos.log())
      .filter(([label]) => label !== "PUT part 1")
      .toSorted(),
  ).toEqual([
    ["PUT part 2", 200],
    ["PUT part 3", 200],
  ]);
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "cancelled", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["PUT part 1", "200", "resumed"],
    ["/complete", "200", ""],
  ]);
  await expectStoredAsResult(page, file.path);
  expect(await chaos.uploadsLeft()).toEqual([]);
});
