// Copies: single and in ranged parts, with headers kept and a changing source refused.

import { expect, it } from "vitest";
import type { FetchLike } from "../../storage/driver.ts";
import type { Gap } from "../storage-contract.ts";
import { type ContractSuite, offsetBytes, text } from "./suite.ts";

export function copyCases(suite: ContractSuite): void {
  const { key, partSize, skipWithout } = suite;

  it("copies an object with its type and metadata", async () => {
    const { driver } = suite;
    expect(
      (await driver.put(key("copy-source.txt"), "copy me", { type: "text/plain", metadata: { "cloudrop-id": "f4" } }))
        .error,
    ).toBeNull();
    expect((await driver.copy(key("copy-source.txt"), key("copy-target.txt"))).error).toBeNull();
    expect((await driver.head(key("copy-target.txt"))).data).toMatchObject({
      size: 7,
      type: "text/plain",
      metadata: { "cloudrop-id": "f4" },
    });
    expect(text((await driver.getRange(key("copy-target.txt"), 0, 6)).data)).toBe("copy me");
  });

  it("copies a larger object in ranged parts with its type and metadata", async (ctx) => {
    const { driver, target } = suite;
    skipWithout(ctx, "copyPartPrecondition");
    const size = partSize();
    const body = offsetBytes(size + 1024);
    const options = { type: "application/octet-stream", metadata: { "cloudrop-id": "f5" } };
    expect((await driver.put(key("big-source.bin"), body, options)).error).toBeNull();
    // A single-PUT limit of one part forces UploadPartCopy with x-amz-copy-source-range, without a 5 GiB source.
    const small = target.driverWith({ maxSinglePutSize: size });
    expect((await small.copy(key("big-source.bin"), key("big-copy.bin"))).error).toBeNull();
    expect((await driver.head(key("big-copy.bin"))).data).toMatchObject({ size: body.length, ...options });
    expect((await driver.getRange(key("big-copy.bin"), size - 2, size + 1)).data).toEqual(
      body.slice(size - 2, size + 2),
    );
  });

  it.for<{ name: string; inParts: boolean; needs: Gap[] }>([
    { name: "a single copy", inParts: false, needs: [] },
    { name: "a copy in ranged parts", inParts: true, needs: ["copyPartPrecondition"] },
  ])("fails $name cleanly when the source is overwritten after it was read", async ({ inParts, needs }, ctx) => {
    const { driver, target } = suite;
    skipWithout(ctx, ...needs);
    const from = key(`changing-${inParts ? "parts" : "single"}.bin`);
    const to = key(`changing-${inParts ? "parts" : "single"}-copy.bin`);
    const size = inParts ? partSize() + 1024 : 16;
    expect((await driver.put(from, offsetBytes(size))).error).toBeNull();
    // Same size, other bytes: only the ETag tells the two versions apart.
    const overwriteAfterHead: FetchLike = async (input, init) => {
      const response = await target.http(input, init);
      if (init?.method === "HEAD") expect((await driver.put(from, new Uint8Array(size))).error).toBeNull();
      return response;
    };
    const copier = target.driverWith({
      fetch: overwriteAfterHead,
      maxSinglePutSize: inParts ? partSize() : undefined,
    });
    expect((await copier.copy(from, to)).error).toMatchObject({
      code: "STORAGE_ERROR",
      retryable: true,
      message: "The object to copy changed during the copy. Retry the copy.",
    });
    expect((await driver.head(to)).data).toBeNull();
  });
}
