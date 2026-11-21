// The storage contract: one set of cases every backend runs unchanged (the in-process fake in the unit lane; RustFS,
// Wrangler local R2 and real R2 in their integration lanes), so the driver is proven to behave the same everywhere.

import { afterAll, beforeAll, describe } from "vitest";
import type { CloudropErrorCode } from "../errors.ts";
import type { FetchLike, StorageDriver } from "../storage/driver.ts";
import { toHex } from "../storage/sigv4.ts";
import { bucketSettingsCases } from "./storage-contract/bucket-settings.ts";
import { copyCases } from "./storage-contract/copy.ts";
import { listCases } from "./storage-contract/list.ts";
import { multipartCases } from "./storage-contract/multipart.ts";
import { objectCases } from "./storage-contract/objects.ts";
import { presignedGetCases } from "./storage-contract/presigned-get.ts";
import { presignedPutCases } from "./storage-contract/presigned-put.ts";
import { contractSuite } from "./storage-contract/suite.ts";

export { offsetBytes } from "./storage-contract/suite.ts";

/** A feature some backend lacks; the cases that need it skip on that backend with the recorded reason. */
export type Gap =
  | "signedHeaders"
  | "unequalParts"
  | "checksums"
  | "listParts"
  | "listPartChecksums"
  | "crc64nvme"
  | "conditionalCompletion"
  | "copyPartPrecondition"
  | "responseOverrides"
  | "finishedUploadsLinger"
  | "bucketSettingsWrites";

export interface ContractTarget {
  /** The driver every case uses, built the way an application builds it (the public preset where there is one). */
  driver: StorageDriver;
  /**
   * A variant driver: `secondsAgo` moves its signing clock back, `maxSinglePutSize` lowers that rule, `fetch` replaces
   * its transport (default: the lane's own).
   */
  driverWith(options: { secondsAgo?: number; maxSinglePutSize?: number; fetch?: FetchLike }): StorageDriver;
  /** Made by randomPrefix, which the suite checks: teardown deletes everything under it and nothing else. */
  prefix: string;
  /** Sends presigned requests the way a browser would. */
  http: FetchLike;
  /** Backend gaps: each present entry names what the backend does instead. Cases that need the feature skip with that
   * reason; "finishedUploadsLinger" instead changes what two cases expect after an upload has finished. */
  gaps: Partial<Record<Gap, string>>;
  /**
   * What the backend does with an extra `x-amz-meta-*` header that a presigned PUT did not sign. Each lane records its
   * backend's measured answer and the contract checks it. Real R2 rejects it (live lane, 2026-11-15).
   */
  unsignedMetaOnPresignedPut: "stored" | "ignored" | "rejected";
  /** The S3 error code for an expired presigned URL. Default "ExpiredRequest" (R2); AWS-style backends answer "AccessDenied". */
  expiredUrlCode?: string;
  /** The cloudrop error code a completion answers when the last part is larger than the others. Default "INVALID_PART" (R2). */
  unequalPartsCode?: CloudropErrorCode;
  /** The S3 error code when `unsignedMetaOnPresignedPut` is "rejected". Default "SignatureDoesNotMatch" (R2). */
  unsignedMetaCode?: string;
}

/**
 * Connects to a backend. Register each cleanup with `onCleanup` the moment its resource exists: cleanups run after
 * the suite (last registered first), also when `connect` itself throws halfway. A lane whose service is started and
 * removed by its shell script's trap (RustFS, Wrangler) has nothing to register.
 */
export type ConnectTarget = (onCleanup: (cleanup: () => Promise<void>) => void) => Promise<ContractTarget>;

export function randomPrefix(root: string): string {
  return `${root}cloudrop-${toHex(crypto.getRandomValues(new Uint8Array(16)))}/`;
}

// Exactly what randomPrefix appends, so a lane cannot point teardown at "" or a shared root such as "live-test/".
const RUN_PREFIX = /(^|\/)cloudrop-[0-9a-f]{32}\/$/;

function checkRunPrefix(prefix: string): void {
  if (!RUN_PREFIX.test(prefix)) {
    throw new Error(
      `The contract prefix "${prefix}" was not made by randomPrefix(); refusing to delete anything under it.`,
    );
  }
}

/**
 * Deletes every object under a run prefix. It refuses a prefix randomPrefix did not make, deletes nothing when the
 * listing returns a key outside the prefix, and fails instead of looping when a deleted key is listed again.
 */
export async function clearRunPrefix(driver: StorageDriver, prefix: string): Promise<void> {
  checkRunPrefix(prefix);
  const sent = new Set<string>();
  for (;;) {
    const page = await driver.list(prefix);
    if (page.error) throw page.error;
    const keys = page.data.items.map((item) => item.key);
    if (keys.length === 0) return;
    const outside = keys.filter((key) => !key.startsWith(prefix));
    if (outside.length > 0) {
      throw new Error(
        `The listing for ${prefix} returned keys outside it; refusing to delete anything: ${outside.join(", ")}`,
      );
    }
    const survived = keys.filter((key) => sent.has(key));
    if (survived.length > 0) throw new Error(`These keys survived deletion: ${survived.join(", ")}`);
    const removed = await driver.deleteMany(keys);
    if (removed.error) throw removed.error;
    if (removed.data.failed.length > 0) {
      const failed = removed.data.failed.map(({ key, error }) => `${key} (${error.code})`);
      throw new Error(`Could not delete: ${failed.join(", ")}`);
    }
    for (const key of keys) sent.add(key);
  }
}

export interface OpenUpload {
  key: string;
  uploadId: string;
}

/**
 * The suite's teardown: aborts the uploads the suite opened, deletes the run prefix, then runs the lane's cleanups,
 * last registered first. `run` is undefined when connecting failed. Uploads the driver starts itself (a multipart
 * copy) are not tracked: if the process dies mid-copy, teardown cannot find them; R2's default lifecycle rule aborts
 * incomplete multipart uploads after 7 days.
 * Every step runs even when an earlier one fails, and every failure is reported: a throwing cleanup must neither hide
 * why teardown failed nor skip the cleanups registered before it.
 */
export async function tearDownRun(
  run: { driver: StorageDriver; prefix: string; openUploads: OpenUpload[] } | undefined,
  cleanups: (() => Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  // Inside the promise chain, so a step that throws before returning a promise is caught too.
  const attempt = (step: () => Promise<void>) =>
    Promise.resolve()
      .then(step)
      .catch((error: unknown) => errors.push(error));
  if (run) {
    const { driver, prefix, openUploads } = run;
    await attempt(async () => {
      const outcomes = await Promise.all(
        openUploads.map(async ({ key, uploadId }) => {
          const { error } = await driver.abortMultipart(key, uploadId);
          return error ? `${key} (${error.code})` : "";
        }),
      );
      const failed = outcomes.filter(Boolean);
      if (failed.length > 0) throw new Error(`Could not abort: ${failed.join(", ")}`);
    });
    await attempt(() => clearRunPrefix(driver, prefix));
  }
  for (const cleanup of cleanups.toReversed()) await attempt(cleanup);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Teardown failed in ${errors.length} steps.`);
}

export function describeStorageContract(name: string, connect: ConnectTarget): void {
  describe(`storage contract: ${name}`, () => {
    let target: ContractTarget;
    const cleanups: (() => Promise<void>)[] = [];
    const openUploads: OpenUpload[] = [];
    const suite = contractSuite(() => target, openUploads);

    beforeAll(async () => {
      const connected = await connect((cleanup) => cleanups.push(cleanup));
      checkRunPrefix(connected.prefix);
      target = connected;
    });

    afterAll(() => tearDownRun(target && { driver: target.driver, prefix: target.prefix, openUploads }, cleanups));

    // Registered in this order, so every lane log lists the cases the same way.
    objectCases(suite);
    presignedPutCases(suite);
    multipartCases(suite);
    copyCases(suite);
    presignedGetCases(suite);
    listCases(suite);
    bucketSettingsCases(suite);
  });
}
