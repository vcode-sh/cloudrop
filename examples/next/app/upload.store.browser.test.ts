// The home page with the example's database store (CLOUDROP_EXAMPLE_STORE), the lanes' second pass. Discarding an
// unfinished upload sends its /abort, which ends the upload's pending row and frees the bytes it reserved against the
// quota. The oracle is /api/usage, which reads cloudrop.api.usage.
import { expect, type Page, test } from "@playwright/test";
import type { UsageInfo } from "./api/usage/route";
import { leaveUnfinished, signIn, unfinishedList } from "./home-page";
import { onDiskFile } from "./lab-page";

/** The signed-in user's usage, as the lab reads it. */
async function usage(page: Page): Promise<Extract<UsageInfo, { store: true }>> {
  const response = await page.request.get("/api/usage");
  expect(response.status()).toBe(200);
  const info = (await response.json()) as UsageInfo;
  if (!info.store) throw new Error("/api/usage reports no store. Run this file with CLOUDROP_EXAMPLE_STORE set.");
  return info;
}

test("Discard ends the upload's row: the bytes it reserved are free again", async ({ page }, testInfo) => {
  const file = await onDiskFile(testInfo, 20);
  await signIn(page);
  const before = await usage(page);
  await leaveUnfinished(page, [file.path]);
  const whileUnfinished = await usage(page);

  await unfinishedList(page)
    .getByRole("button", { name: `Discard ${file.name}` })
    .click();
  await expect(page.getByRole("heading", { name: "Unfinished uploads" })).toHaveCount(0);

  expect(whileUnfinished.reservedBytes).toBe(before.reservedBytes + 20_971_520);
  expect(await usage(page)).toEqual(before);
});
