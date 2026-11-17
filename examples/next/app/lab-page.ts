// What the lab's browser tests read from the page and stage on disk, shared by every `lab*.browser.test.ts`.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";

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
