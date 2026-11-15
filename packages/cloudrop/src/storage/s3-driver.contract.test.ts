import { describe, expect, it } from "vitest";
import { CloudropError, fail, ok } from "../errors.ts";
import { R2_RULES } from "../rules.ts";
import { createFakeR2 } from "../testing/fake-r2.ts";
import { clearRunPrefix, describeStorageContract, randomPrefix, tearDownRun } from "../testing/storage-contract.ts";
import type { StorageDriver } from "./driver.ts";
import { r2 } from "./presets.ts";
import { createS3Driver } from "./s3-driver.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
const accountId = "0123456789abcdef0123456789abcdef";
const bucket = "contract";

describeStorageContract("in-process fake R2", async (onCleanup) => {
  const fake = createFakeR2({ bucket, credentials });
  // Runs after the suite has removed its objects and aborted its uploads, so it proves the suite leaves none behind.
  onCleanup(async () => {
    if (fake.pendingUploads() > 0) throw new Error(`The suite left ${fake.pendingUploads()} multipart uploads open.`);
  });
  return {
    // The public preset, as the live R2 lane uses it.
    driver: r2({ bucket, accountId, ...credentials, fetch: fake.fetch }),
    driverWith: ({ secondsAgo = 0, maxSinglePutSize = R2_RULES.maxSinglePutSize }) =>
      createS3Driver({
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        region: "auto",
        bucket,
        credentials,
        rules: { ...R2_RULES, maxSinglePutSize },
        fetch: fake.fetch,
        now: () => new Date(Date.now() - secondsAgo * 1000),
      }),
    prefix: randomPrefix("contract/"),
    http: fake.fetch,
    gaps: { crc64nvme: "the fake does not compute CRC64NVME" },
    // The fake checks only the headers a URL signs, so it stores an extra x-amz-meta-* header like a signed one.
    unsignedMetaOnPresignedPut: "stored",
  };
});

// The live lane runs this teardown against the owner's bucket: it must never delete outside the run's own prefix.
describe("contract teardown", () => {
  // A fresh fake per test, so no test sees another's objects.
  const setup = () => {
    const driver = r2({ bucket, accountId, ...credentials, fetch: createFakeR2({ bucket, credentials }).fetch });
    return { driver, exists: async (key: string) => (await driver.head(key)).data !== null };
  };

  it("refuses a prefix that randomPrefix did not make and deletes nothing", async () => {
    const { driver, exists } = setup();
    expect((await driver.put("contract/keep.txt", "owner data")).error).toBeNull();
    await expect(clearRunPrefix(driver, "contract/")).rejects.toThrow(
      'The contract prefix "contract/" was not made by randomPrefix(); refusing to delete anything under it.',
    );
    expect(await exists("contract/keep.txt")).toBe(true);
  });

  it("refuses to delete listed keys outside the run prefix and deletes nothing", async () => {
    const { driver, exists } = setup();
    const prefix = randomPrefix("contract/");
    const keys = [`${prefix}mine.txt`, "contract/owner-data/keep.txt"];
    expect((await Promise.all(keys.map((key) => driver.put(key, "x")))).map((result) => result.error)).toEqual([
      null,
      null,
    ]);
    // A list that drops the end of the prefix, as a prefix-encoding bug would.
    const misdirected: StorageDriver = { ...driver, list: (given, options) => driver.list(given.slice(0, 9), options) };
    await expect(clearRunPrefix(misdirected, prefix)).rejects.toThrow(
      `The listing for ${prefix} returned keys outside it; refusing to delete anything: contract/owner-data/keep.txt`,
    );
    expect(await Promise.all(keys.map(exists))).toEqual([true, true]);
  });

  it("fails when a key it deleted is listed again", async () => {
    const { driver } = setup();
    const prefix = randomPrefix("contract/");
    expect((await driver.put(`${prefix}ghost.txt`, "x")).error).toBeNull();
    // Reports success without deleting, as a DELETE that encodes the key wrongly would.
    const ghostly: StorageDriver = { ...driver, deleteMany: async (keys) => ok({ deleted: [...keys], failed: [] }) };
    await expect(clearRunPrefix(ghostly, prefix)).rejects.toThrow(`These keys survived deletion: ${prefix}ghost.txt`);
  });

  it("still deletes the run's objects when aborting an upload fails", async () => {
    const { driver, exists } = setup();
    const prefix = randomPrefix("contract/");
    expect((await driver.put(`${prefix}left.txt`, "x")).error).toBeNull();
    const denied = new CloudropError("STORAGE_DENIED", "Abort denied by the test.");
    const failingAbort: StorageDriver = { ...driver, abortMultipart: async () => fail(denied) };
    const openUploads = [{ key: `${prefix}upload.bin`, uploadId: "upload-1" }];
    await expect(tearDownRun({ driver: failingAbort, prefix, openUploads }, [])).rejects.toThrow(
      `Could not abort: ${prefix}upload.bin (STORAGE_DENIED)`,
    );
    expect(await exists(`${prefix}left.txt`)).toBe(false);
  });

  it("runs the remaining cleanups when one throws synchronously, and reports it", async () => {
    const ran: string[] = [];
    const cleanups = [
      async () => {
        ran.push("registered first");
      },
      (): Promise<void> => {
        throw new Error("Cleanup threw before returning a promise.");
      },
    ];
    await expect(tearDownRun(undefined, cleanups)).rejects.toThrow("Cleanup threw before returning a promise.");
    expect(ran).toEqual(["registered first"]);
  });
});
