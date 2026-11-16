// Presigned GET: serving an object, with and without a signed download name.

import { expect, it } from "vitest";
import type { ContractSuite } from "./suite.ts";

export function presignedGetCases(suite: ContractSuite): void {
  const { key, skipWithout } = suite;

  it("serves an object through a presigned GET", async () => {
    const { driver, target } = suite;
    const k = key("download.txt");
    expect((await driver.put(k, "hello", { type: "text/plain" })).error).toBeNull();
    const signed = await driver.presignGet(k, { expiresIn: 300 });
    if (signed.error) throw signed.error;
    const response = await target.http(signed.data.url);
    expect({ status: response.status, body: await response.text() }).toEqual({ status: 200, body: "hello" });
  });

  it("serves a presigned GET with the download name signed into it", async (ctx) => {
    const { driver, target } = suite;
    skipWithout(ctx, "responseOverrides");
    const k = key("named-download.txt");
    expect((await driver.put(k, "hello", { type: "text/plain" })).error).toBeNull();
    const signed = await driver.presignGet(k, { expiresIn: 300, disposition: 'attachment; filename="report.txt"' });
    if (signed.error) throw signed.error;
    const response = await target.http(signed.data.url);
    await response.arrayBuffer();
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.txt"');
  });
}
