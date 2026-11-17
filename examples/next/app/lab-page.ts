// What the lab's browser tests read from the page, stage on disk and read back from the bucket, shared by every
// `lab*.browser.test.ts` and the `*.chaos.browser.test.ts` rows.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type CDPSession, expect, type Page, type TestInfo, test } from "@playwright/test";
import { storage } from "../lib/cloudrop";

const MIB = 1024 * 1024;

/** Signs in through the lab's form; the server answers with a redirect back to /lab. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/lab");
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Sign in as the demo user" }).click(),
  ]);
}

/** Each logged request as [kind, status, note], in the order the page shows them. */
export function requestRows(page: Page): Promise<string[][]> {
  return page
    .getByRole("table", { name: "Requests" })
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => [...row.querySelectorAll("td")].slice(0, 3).map((cell) => cell.textContent ?? "")),
    );
}

/** Each file of the job as [name, status], in the order the page shows them. */
export function fileRows(page: Page): Promise<[name: string, status: string][]> {
  return page
    .getByRole("table", { name: "Files" })
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")))
    .then((rows) => rows.map((cells): [string, string] => [cells[0] ?? "", cells[5] ?? ""]));
}

export const summaryValue = (page: Page, term: string) => page.locator(`dt:text-is("${term}") + dd`);

/**
 * No signed URL on the page: no signature parameter, and nothing after the bucket host that could be a query. The host
 * comes from the server's settings (/api/lab-info), not from what the page recorded of the requests.
 */
export async function expectNoSignedUrl(page: Page): Promise<void> {
  const host = (await summaryValue(page, "Storage host").textContent()) ?? "";
  expect(host).toMatch(/^[\w.…-]+(?::\d+)?$/);
  const text = (await page.locator("body").textContent()) ?? "";
  expect(text).not.toContain("X-Amz-Signature");
  expect(text).not.toMatch(new RegExp(`${host.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\S*\\?`));
}

/**
 * A file of `mib` MiB on disk, in the test's output directory inside the worktree, written once: a reload that picks it
 * again gets the same `lastModified`, which a file made in the page cannot keep. Bytes 0, 1, …, 250, 0, 1, …, so a part
 * stored at the wrong offset reads back different.
 */
export async function onDiskFile(testInfo: TestInfo, mib: number): Promise<{ path: string; name: string }> {
  const name = `on-disk-${mib}-MiB.bin`;
  const path = testInfo.outputPath(name);
  if (!existsSync(path)) {
    const bytes = new Uint8Array(mib * MIB);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    await writeFile(path, bytes);
  }
  return { path, name };
}

/** Chooses `path` through the lab's file input, as a person picking a file on disk does. */
export async function chooseOnDisk(page: Page, path: string): Promise<void> {
  await page.getByLabel("Files to upload").setInputFiles(path);
}

/** Each unfinished upload the page lists as [name, bytes]; none while the table is absent. */
export function unfinishedRows(page: Page): Promise<[name: string, bytes: string][]> {
  return page
    .getByRole("table", { name: "Unfinished uploads" })
    .locator("tbody tr")
    .evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")))
    .then((rows) => rows.map((cells): [string, string] => [cells[0] ?? "", cells[1] ?? ""]));
}

/** Picks `path` through the Resume input of the unfinished upload named `name`. */
export async function resumeWith(page: Page, name: string, path: string): Promise<void> {
  const table = page.getByRole("table", { name: "Unfinished uploads" });
  await table.getByLabel(`Resume ${name}`, { exact: true }).setInputFiles(path);
}

/** Waits until the request table shows a "PUT part 1" the bucket answered 200: that part is stored. */
export async function partOneStored(page: Page): Promise<void> {
  await expect
    .poll(async () => (await requestRows(page)).some(([kind, status]) => kind === "PUT part 1" && status === "200"), {
      intervals: [100],
      timeout: 20_000,
    })
    .toBe(true);
}

/** The key the Result figure shows for the run's one file. */
export async function resultKey(page: Page): Promise<string> {
  const text = (await page.getByRole("figure", { name: "Result" }).textContent()) ?? "";
  const key = /"key": "([^"]+)"/.exec(text)?.[1];
  if (!key) throw new Error("The Result figure shows no key.");
  return key;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The object under the Result figure's key, read back through the example's own storage, holds the file at `path`. */
export async function expectStoredAsResult(page: Page, path: string): Promise<void> {
  const bytes = await readFile(path);
  const { data: stored, error } = await storage.getRange(await resultKey(page), 0, bytes.length - 1);
  expect(error).toBeNull();
  expect(sha256(stored ?? new Uint8Array())).toBe(sha256(bytes));
}

/** Chromium's emulated network: uploads at `bytesPerSecond` (-1 for no limit), or offline. */
export const uploadsAt = (bytesPerSecond: number, offline = false) => ({
  offline,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: bytesPerSecond,
});

/** Throttles uploads inside Chromium; the session it returns changes the network conditions later. */
export async function throttleUploads(page: Page, bytesPerSecond: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", uploadsAt(bytesPerSecond));
  return cdp;
}

/** Reads the value of the file's bar every 100 ms until the returned function is called, which gives the values. */
export function sampleProgress(page: Page, name: string): () => Promise<number[]> {
  const bar = page.getByRole("progressbar", { name: `Progress of ${name}` });
  const samples: number[] = [];
  let sampling = true;
  const loop = (async () => {
    while (sampling) {
      samples.push(await bar.evaluate((element: HTMLProgressElement) => element.value));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return async () => {
    sampling = false;
    await loop;
    // Kept with the test's result, as evidence of how the bar moved.
    test.info().annotations.push({ type: "progress samples", description: samples.join(" ") });
    return samples;
  };
}
