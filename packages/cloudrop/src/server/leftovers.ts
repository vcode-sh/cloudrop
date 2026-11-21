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
const URL_LIFETIME_MS = URL_LIFETIME_SECONDS * 1000;
/**
 * A signed URL's life: no URL outlives its token's deadline, so with at least this grace no new PUT can start after a
 * row's deadline or end once the sweep may clean it up.
 */
export const MIN_GRACE_MS: number = URL_LIFETIME_MS;

/** 30 days, far beyond any upload: the sweep subtracts the grace from the time, which must stay a date a database stores. */
const MAX_GRACE_MS = 2_592_000_000;

/** A `graceMs` option from 15 minutes to 30 days, `what` naming what the least is for; the default when left out. */
export function readGrace(graceMs: unknown, what: string): Result<number> {
  const value = graceMs ?? DEFAULT_GRACE_MS;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_GRACE_MS && value <= MAX_GRACE_MS) {
    return ok(value);
  }
  return fail(
    invalidInput(
      `graceMs must be at least ${MIN_GRACE_MS} (15 minutes), ${what}, and at most ${MAX_GRACE_MS} (30 days).`,
    ),
  );
}

/**
 * Aborts the row's multipart upload (unless the row completed it) and deletes the object at its key only when the
 * object is this row's: a key may hold a later upload's file. Answers the time the check started, the one to mark the
 * row cleaned with: `cleaned_at` never claims a look later than the one the storage got.
 */
export async function removeLeftovers(config: ServerConfig, record: FileRecord): Promise<Result<Date>> {
  const { storage } = config;
  const checkedAt = new Date();
  if (record.uploadId && record.completedAt === null) {
    const aborted = await storage.abortMultipart(record.key, record.uploadId);
    if (aborted.error) return aborted;
  }
  const head = await storage.head(record.key);
  if (head.error) return head;
  if (head.data?.metadata["cloudrop-id"] !== record.id) return ok(checkedAt);
  const removed = await storage.delete(record.key);
  return removed.error ? removed : ok(checkedAt);
}

/**
 * When a check of the bucket for this row's object becomes final, in milliseconds: `graceMs` after the last moment one
 * of its URLs could start a PUT. URLs are signed while the row is pending (its last claim, or its end, is when it left
 * pending), each works for 15 minutes, and none outlives the token, so that moment is the earlier of the token's
 * deadline and 15 minutes after the row left pending. A URL signed a moment after that, by an /upload or /sign that
 * read the row just before, starts its PUT within the grace all the same. The grace leaves a PUT under way time to land.
 */
export function settledAt(record: FileRecord, graceMs: number): number {
  const leftPending = (record.claimedAt ?? record.endedAt ?? record.expiresAt).getTime();
  return Math.min(record.expiresAt.getTime(), leftPending + URL_LIFETIME_MS) + graceMs;
}

/**
 * Removes what a `deleted` row left, and answers whether the row is now marked cleaned: only when that check is final
 * under the default grace. Otherwise `cleaned_at` stays null, so the sweep's cleanup pass checks the key again once the
 * grace has passed. A failure never fails the caller, as the row is deleted either way (M11-D2): it is logged, a
 * storage one here as the `what` file's, and the sweep finishes the work.
 */
export async function removeDeleted(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  record: FileRecord,
  what: "deleted" | "replaced",
): Promise<boolean> {
  const checked = await removeLeftovers(config, record);
  if (checked.error) {
    config.logger.error(
      `cloudrop: could not remove the ${what} file ${record.id} from the bucket. The sweep removes it later.`,
      checked.error,
    );
    return false;
  }
  const checkedAt = checked.data;
  if (checkedAt.getTime() < settledAt(record, DEFAULT_GRACE_MS)) return false;
  const marked = await storeCall(config.logger, `mark file ${record.id} cleaned`, () =>
    store.cleaned(record.id, checkedAt),
  );
  return !marked.error;
}
