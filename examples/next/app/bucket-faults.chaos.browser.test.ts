// What the bucket does to a PUT, through the chaos proxy that scripts/test-browser.sh puts between the example and
// RustFS (chaos design §4 rows 1, 3, 4, 7, 8, 9 and 12): resets, a busy bucket, refusals the page can read and ones it
// cannot, an answer lost after the bucket stored the bytes. The oracles: what reached the bucket (the proxy's log), the
// requests the lab's table shows, and the object read back through the example's own storage.
import type { Page } from "@playwright/test";
import { bucketPuts, type ChaosEntry, type ChaosRule, expect, test } from "./chaos-control";
import {
  chooseOnDisk,
  expectStoredAsResult,
  fileRows,
  onDiskFile,
  requestRows,
  sampleProgress,
  signIn,
  throttleUploads,
} from "./lab-page";

const MIB = 1024 * 1024;
const PART_ONE = { kind: "presigned", operation: "UploadPart", part: 1 } as const;
const PART_TWO = { kind: "presigned", operation: "UploadPart", part: 2 } as const;

// Chromium itself sends a PUT again when a connection it reused is reset before any answer byte, on a new connection
// unless another idle one is open, and the page hears nothing (measured 2026-11-17: one reset reached the proxy, the
// page saw one PUT). A PUT reuses its preflight's connection, so a reset rule faults the first two arrivals: whichever
// connection Chromium used, the client sees exactly one network error.
const firstTwo = (match: ChaosRule["match"], fault: ChaosRule["fault"]): ChaosRule[] => [
  { match, fault },
  { match: { ...match, nth: 2 }, fault },
];

// Error bodies as measured: R2's 429 (r2-spike-findings.md, Q9) and expired URL (row 7), RustFS's expired URL
// (s3-driver.rustfs.integration.test.ts).
const R2_BUSY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code><Message>Reduce your concurrent request rate for the same object.</Message></Error>';
const R2_EXPIRED =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ExpiredRequest</Code><Message>Request has expired</Message></Error>';
const RUSTFS_EXPIRED =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>';
const BAD_SIGNATURE =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message></Error>';

async function upload(page: Page, path: string): Promise<void> {
  await chooseOnDisk(page, path);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
}

/** The presigned PUTs that reached the bucket, sorted: parts sent at once arrive in any order. */
const sortedPuts = (log: readonly ChaosEntry[]) => bucketPuts(log).toSorted();

/** The server's multipart calls: how many uploads it created, completed and aborted. */
const multipartCalls = (log: readonly ChaosEntry[]) =>
  log.filter((entry) => entry.kind === "server" && entry.label.endsWith("MultipartUpload")).map((entry) => entry.label);

test("a part reset mid-body is renewed and sent again, and the bar never goes back", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await chaos.set(firstTwo(PART_TWO, { kind: "reset", afterBytes: MIB }));
  await signIn(page);
  // 4 MiB/s inside Chromium, so the bar is sampled while the parts send, and parts 1 and 3 hold their connections
  // while part 2 is reset: no idle one is left for Chromium to send it again on.
  await throttleUploads(page, 4 * MIB);
  await upload(page, file.path);
  const stopSampling = sampleProgress(page, file.name);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  const samples = await stopSampling();
  // Part 2's bytes count once, at their best: its resend from zero does not pull the bar back (M3-U11).
  expect(samples).toEqual(samples.toSorted((a, b) => a - b));
  expect(samples.at(-1)).toBe(20 * MIB);
  expect(sortedPuts(await chaos.log())).toEqual([
    ["PUT part 1", 200],
    ["PUT part 2", 200],
    ["PUT part 2", "reset"],
    ["PUT part 2", "reset"],
    ["PUT part 3", 200],
  ]);
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "network error", ""],
    ["PUT part 3", "200", ""],
    ["/sign", "200", "renewal of part 2"],
    ["PUT part 2", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  await expectStoredAsResult(page, file.path);
});

test("a file whose part 2 was reset six times is retried with its ticket, sending part 2 alone", async ({
  page,
  chaos,
}, testInfo) => {
  // Six attempts wait up to 0.5 + 1 + 2 + 4 + 8 s between them (M3-S9) before the file fails.
  test.setTimeout(60_000);
  const file = await onDiskFile(testInfo, 20);
  await chaos.set([{ match: { ...PART_TWO, nth: "every" }, fault: { kind: "reset", afterBytes: MIB } }]);
  await signIn(page);
  await upload(page, file.path);
  await expect(page.getByRole("status")).toContainText("failed with NETWORK_ERROR", { timeout: 30_000 });
  const failed = await requestRows(page);
  expect(failed).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "network error", ""],
    ["PUT part 3", "200", ""],
    ["/sign", "200", "renewal of part 2"],
    ...Array(5).fill(["PUT part 2", "network error", "retry"]),
  ]);
  await chaos.set([]);

  await page.getByRole("button", { name: "Retry", exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed after Retry");
  // The same ticket: no new /upload, and the parts that landed are not sent again (§4.7, M3-U30).
  expect((await requestRows(page)).slice(failed.length)).toEqual([
    ["PUT part 2", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  const log = await chaos.log();
  expect(
    bucketPuts(log)
      .filter(([label]) => label !== "PUT part 2")
      .toSorted(),
  ).toEqual([
    ["PUT part 1", 200],
    ["PUT part 3", 200],
  ]);
  // Each of the client's six attempts reached the bucket, again when Chromium resent it on a reused connection; then
  // the retry stored it.
  const partTwo = bucketPuts(log)
    .filter(([label]) => label === "PUT part 2")
    .map(([, outcome]) => outcome);
  expect(partTwo.at(-1)).toBe(200);
  expect(partTwo.slice(0, -1).filter((outcome) => outcome !== "reset")).toEqual([]);
  expect(partTwo.length - 1).toBeGreaterThanOrEqual(6);
  expect(multipartCalls(log)).toEqual(["CreateMultipartUpload", "CompleteMultipartUpload"]);
  await expectStoredAsResult(page, file.path);
});

// A 429 with Retry-After: 2, readable through CORS in both variants. Where the bucket exposes the header, the client
// waits at least 2 s; where it does not, only its own jitter, whose first ceiling is 0.5 s (M3-U25, decision M3-K8).
for (const { exposed, gap } of [
  { exposed: true, gap: (ms: number) => expect(ms).toBeGreaterThanOrEqual(2000) },
  { exposed: false, gap: (ms: number) => expect(ms).toBeLessThan(2000) },
]) {
  test(`a busy bucket's 429 is retried without a renewal, Retry-After ${exposed ? "exposed" : "hidden"}`, async ({
    page,
    chaos,
  }, testInfo) => {
    const file = await onDiskFile(testInfo, 20);
    const busy = { status: 429, body: R2_BUSY, headers: { "retry-after": "2" }, exposeRetryAfter: exposed };
    await chaos.set([{ match: PART_ONE, fault: { kind: "answer", ...busy } }]);
    await signIn(page);
    await upload(page, file.path);

    await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
    const [refused, retried, ...more] = (await chaos.log()).filter((entry) => entry.label === "PUT part 1");
    expect(more).toEqual([]);
    expect([refused?.outcome, retried?.outcome]).toEqual([429, 200]);
    gap((retried?.startMs ?? 0) - (refused?.endMs ?? 0));
    expect(await requestRows(page)).toEqual([
      ["/upload", "200", ""],
      ["PUT part 1", "429", ""],
      ["PUT part 2", "200", ""],
      ["PUT part 3", "200", ""],
      ["PUT part 1", "200", "retry"],
      ["/complete", "200", ""],
    ]);
    await expectStoredAsResult(page, file.path);
  });
}

test("a readable SignatureDoesNotMatch fails the file at once; Retry starts it again with a new ticket", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await chaos.set([{ match: PART_ONE, fault: { kind: "answer", status: 403, body: BAD_SIGNATURE } }]);
  await signIn(page);
  await upload(page, file.path);
  await expect(page.getByRole("status")).toContainText("failed with UPLOAD_REJECTED");
  const result = page.getByRole("figure", { name: "Result" });
  await expect(result).toContainText("its bytes do not match what the server signed");
  await expect(result).toContainText('"retryable": false');

  await page.getByRole("button", { name: `Retry ${file.name}`, exact: true }).click();

  await expect(page.getByRole("status")).toContainText("completed after Retry");
  // One attempt at part 1, no renewal; UPLOAD_REJECTED needs a new ticket, so every part goes again (M3-U31).
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "403", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/upload", "200", "new ticket"],
    ["PUT part 1", "200", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/complete", "200", ""],
  ]);
  // The first ticket's upload is left to the bucket's lifecycle rule, never aborted (M3-U55).
  expect(multipartCalls(await chaos.log())).toEqual([
    "CreateMultipartUpload",
    "CreateMultipartUpload",
    "CompleteMultipartUpload",
  ]);
  expect(await fileRows(page)).toEqual([[file.name, "done"]]);
  await expectStoredAsResult(page, file.path);
});

// An expired URL as R2 and as RustFS answer it, both readable: one renewal through /sign, then the part again (S11).
for (const { bucket, body } of [
  { bucket: "R2", body: R2_EXPIRED },
  { bucket: "RustFS", body: RUSTFS_EXPIRED },
]) {
  test(`a part refused as expired, as ${bucket} says it, is renewed once and sent again`, async ({
    page,
    chaos,
  }, testInfo) => {
    const file = await onDiskFile(testInfo, 20);
    await chaos.set([{ match: PART_ONE, fault: { kind: "answer", status: 403, body } }]);
    await signIn(page);
    await upload(page, file.path);

    await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
    expect(sortedPuts(await chaos.log())).toEqual([
      ["PUT part 1", 200],
      ["PUT part 1", 403],
      ["PUT part 2", 200],
      ["PUT part 3", 200],
    ]);
    expect(await requestRows(page)).toEqual([
      ["/upload", "200", ""],
      ["PUT part 1", "403", ""],
      ["PUT part 2", "200", ""],
      ["PUT part 3", "200", ""],
      ["/sign", "200", "renewal of part 1"],
      ["PUT part 1", "200", "retry"],
      ["/complete", "200", ""],
    ]);
    await expectStoredAsResult(page, file.path);
  });
}

test("a 403 without CORS headers is opaque to the page: renewed, then sent again", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  // As R2 answers an expired URL: no CORS headers (r2-spike-findings.md, "Browser refusals and checksums").
  await chaos.set([{ match: PART_ONE, fault: { kind: "answer", status: 403, body: R2_EXPIRED, cors: false } }]);
  await signIn(page);
  await upload(page, file.path);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  // The bucket answered 403; the page saw only a network error (S10).
  expect(sortedPuts(await chaos.log())).toEqual([
    ["PUT part 1", 200],
    ["PUT part 1", 403],
    ["PUT part 2", 200],
    ["PUT part 3", 200],
  ]);
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT part 1", "network error", ""],
    ["PUT part 2", "200", ""],
    ["PUT part 3", "200", ""],
    ["/sign", "200", "renewal of part 1"],
    ["PUT part 1", "200", "retry"],
    ["/complete", "200", ""],
  ]);
  await expectStoredAsResult(page, file.path);
});

test("a single PUT whose answer was cut is sent again, and its 412 counts as stored", async ({
  page,
  chaos,
}, testInfo) => {
  const file = await onDiskFile(testInfo, 1);
  // The bucket stores the PUT and answers; the client gets a reset before the status line.
  await chaos.set(firstTwo({ kind: "presigned", operation: "PutObject" }, { kind: "truncate", at: "beforeHeaders" }));
  await signIn(page);
  await upload(page, file.path);

  await expect(page.getByRole("status")).toContainText("completed", { timeout: 20_000 });
  // Every PUT carries If-None-Match: *, so after the first arrival the bucket keeps its copy and answers 412 (§5.4).
  expect(bucketPuts(await chaos.log())).toEqual([
    ["PUT object", "reset"],
    ["PUT object", "reset"],
    ["PUT object", 412],
  ]);
  expect(await requestRows(page)).toEqual([
    ["/upload", "200", ""],
    ["PUT single", "network error", ""],
    ["/sign", "200", "renewal"],
    ["PUT single", "412", "retry; already stored"],
    ["/complete", "200", ""],
  ]);
  await expectStoredAsResult(page, file.path);
});
