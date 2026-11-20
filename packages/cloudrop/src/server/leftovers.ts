// What an upload's row may have left in the bucket, and from when a check of the bucket for it is final. The sweep,
// deleteFile, eraseOwner and replacing routes share both, so each removes only the object that is the row's own and
// none calls a row clean while one of its URLs could still put an object back.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { URL_LIFETIME_SECONDS } from "./presign.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";

/** The sweep's default grace, and the one deleteFile and replacing routes use. */
export const DEFAULT_GRACE_MS = 3_600_000;
/**
 * A signed URL's life: no URL outlives its token's deadline, so with at least this grace no new PUT can start after a
 * row's deadline or end once the sweep may clean it up.
 */
export const MIN_GRACE_MS: number = URL_LIFETIME_SECONDS * 1000;

/** A `graceMs` option: at least the life of an upload URL; the default when left out. */
export function readGrace(graceMs: unknown = DEFAULT_GRACE_MS): Result<number> {
  if (typeof graceMs === "number" && Number.isSafeInteger(graceMs) && graceMs >= MIN_GRACE_MS) return ok(graceMs);
  return fail(
    invalidInput(
      `graceMs must be at least ${MIN_GRACE_MS} (15 minutes), the life of an upload URL, so no upload can start after a row's deadline once it may be cleaned up.`,
    ),
  );
}

/**
 * Aborts the row's multipart upload (unless the row completed it) and deletes the object at its key only when the
 * object is this row's: a key may hold a later upload's file.
 */
export async function removeLeftovers(config: ServerConfig, record: FileRecord): Promise<Result<void>> {
  const { storage } = config;
  if (record.uploadId && record.completedAt === null) {
    const aborted = await storage.abortMultipart(record.key, record.uploadId);
    if (aborted.error) return aborted;
  }
  const head = await storage.head(record.key);
  if (head.error) return head;
  if (head.data?.metadata["cloudrop-id"] !== record.id) return ok(undefined);
  return storage.delete(record.key);
}

/**
 * When a check of the bucket for this row's object becomes final, in milliseconds: `graceMs` after the last moment one
 * of its URLs could start a PUT. URLs are signed only while the row is pending and never outlive its token, so that
 * moment is the earlier of the token's deadline and the row leaving pending: its last claim, or its end. The grace,
 * like the sweep's, leaves a PUT already under way time to land.
 */
export function settledAt(record: FileRecord, graceMs: number): number {
  const leftPending = record.claimedAt ?? record.endedAt ?? record.expiresAt;
  return Math.min(record.expiresAt.getTime(), leftPending.getTime()) + graceMs;
}

/**
 * Removes what a `deleted` row left, and marks the row cleaned only when that check is final under the default grace.
 * Otherwise `cleaned_at` stays null, so the sweep's cleanup pass checks the key again once the grace has passed.
 */
export async function removeDeleted(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  record: FileRecord,
): Promise<Result<void>> {
  const removed = await removeLeftovers(config, record);
  if (removed.error || Date.now() < settledAt(record, DEFAULT_GRACE_MS)) return removed;
  return storeCall(config.logger, `mark file ${record.id} cleaned`, () => store.cleaned(record.id, new Date()));
}
