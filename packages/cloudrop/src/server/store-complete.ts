// POST /complete for a stored token (M5 spec §5.5): the file's row decides. A completed row is answered from the
// store with no storage call and no hook; only a pending row is verified, and a guarded claim lets exactly one
// request run onComplete: inside the store's transaction when it has one, otherwise under a lease.

import { fail, ok, type Result } from "../errors.ts";
import type { CompleteResponse, UploadedFile } from "../protocol/types.ts";
import { checkAfterVerify, completeContext, encodeResult, unfinished, uploadedFile } from "./complete-steps.ts";
import { cleanUpRefused, type Verdict, verifyUpload } from "./complete-verify.ts";
import type { EndpointInput, RouteConfig, ServerConfig } from "./config.ts";
import { busy } from "./http.ts";
import { removeDeleted } from "./leftovers.ts";
import { nowSeconds } from "./presign.ts";
import { storeOfRoute } from "./route.ts";
import type { ClaimOutcome, CloudropStore, FileRecord } from "./store.ts";
import { cancelled, type FileCalls, fileCalls, storeUnavailable } from "./store-calls.ts";
import { type UploadTokenPayload, uploadExpired } from "./token.ts";

type Answer = Result<CompleteResponse>;

/** The longest result a row keeps (M5 spec §3): an id or a few fields, not a record. */
const MAX_RESULT_JSON_BYTES = 16 * 1024;
/** One completion attempt: its answer, and the files it replaced when this request recorded the completion. */
type Attempt = { answer: Answer; recorded: false } | { answer: Answer; recorded: true; replaced: FileRecord[] };

interface Completion {
  request: Request;
  config: ServerConfig;
  token: UploadTokenPayload;
  route: RouteConfig;
  file: UploadedFile;
  calls: FileCalls;
}

/** The stored answer: the completion is over, and a deleted file keeps the answer it was given. */
const replay = (record: FileRecord, file: UploadedFile): Answer =>
  ok({ file, data: record.result === null ? null : JSON.parse(record.result) });

/** The answer for a row this request cannot complete. */
function settled(record: FileRecord | null, file: UploadedFile): Answer {
  if (record?.completedAt) return replay(record, file);
  return fail(record?.status === "completing" ? busy() : cancelled());
}

/** The answer the row gives before any storage call, or null when the upload may be completed now. */
function answerFromRow(record: FileRecord | null, { token, file, config }: Completion): Answer | null {
  const claimLive =
    record?.status === "completing" && (record.claimedAt?.getTime() ?? 0) + config.completionLeaseMs >= Date.now();
  const open = record?.status === "pending" || (record?.status === "completing" && !claimLive);
  if (!open) return settled(record, file);
  return nowSeconds() >= token.exp ? fail(uploadExpired()) : null;
}

function claimAnswer(outcome: Exclude<ClaimOutcome, { kind: "claimed" }>, file: UploadedFile): Answer {
  if (outcome.kind === "busy") return fail(busy());
  return settled(outcome.kind === "missing" ? null : outcome.record, file);
}

/** A completion whose claim was taken over after its lease: the winner's answer once it is recorded. */
const lostClaim = (record: FileRecord | null, file: UploadedFile): Answer =>
  record?.completedAt ? replay(record, file) : fail(unfinished());

/**
 * A refusal takes the row first: only a refusal that ended it may delete the object (M5 spec §5.5 step 4). The row then
 * decides, so a failed delete is left to the sweep's cleanup pass and the refusal is answered.
 */
async function refuse(completion: Completion, refusal: Extract<Verdict, { kind: "refused" }>): Promise<Answer> {
  const ended = await completion.calls.end("pending", "rejected");
  if (ended.error) return ended;
  if (ended.data.changed) return cleanUpRefused(completion.config, completion.token, refusal, { rowEnded: true });
  return settled(ended.data.record, completion.file);
}

/** onComplete, then its result as the JSON the row keeps; `extra` is the store's `tx`. */
async function runOnComplete(
  { request, config, token, route, file }: Completion,
  extra: object,
): Promise<Result<{ data: unknown; json: string | null }>> {
  const { onComplete } = route.definition;
  let result: unknown = null;
  try {
    if (onComplete) result = await onComplete({ ...completeContext(request, token, file), ...extra });
  } catch (error) {
    config.logger.error(`cloudrop: onComplete failed for route "${route.name}".`, error);
    return fail(unfinished());
  }
  // No result is stored as null, as the client is sent null (spec §5.4).
  if (result === undefined || result === null) return ok({ data: null, json: null });
  const encoded = encodeResult(config.logger, route.name, result);
  if (encoded.error) return encoded;
  const json = encoded.data ?? null;
  if (json !== null && new TextEncoder().encode(json).length > MAX_RESULT_JSON_BYTES) {
    config.logger.error(
      `cloudrop: onComplete for route "${route.name}" returned more than 16 KiB of JSON. Return ids, not records.`,
    );
    return fail(unfinished());
  }
  return ok({ data: json === null ? null : JSON.parse(json), json });
}

/** Without a transaction: claim under a lease, and hand the row back at once when onComplete fails in-process. */
async function withLease(completion: Completion): Promise<Attempt> {
  const { calls, file, config } = completion;
  const claim = crypto.randomUUID();
  const claimed = await calls.claim(claim, config.completionLeaseMs);
  if (claimed.error) return { answer: claimed, recorded: false };
  if (claimed.data.kind !== "claimed") return { answer: claimAnswer(claimed.data, file), recorded: false };
  const ran = await runOnComplete(completion, {});
  if (ran.error) {
    // A failed release is logged by the call; the lease then frees the row.
    await calls.release(claim);
    return { answer: ran, recorded: false };
  }
  const done = await calls.complete(claim, ran.data.json, completion.route.replace);
  if (done.error) return { answer: done, recorded: false };
  if (!done.data.changed) return { answer: lostClaim(done.data.record, file), recorded: false };
  return { answer: ok({ file, data: ran.data.data }), recorded: true, replaced: done.data.replaced };
}

/** With a transaction: the claim, onComplete's writes through `tx` and the completion commit or roll back together. */
async function inTransaction(
  completion: Completion,
  transaction: NonNullable<CloudropStore<unknown>["transaction"]>,
): Promise<Attempt> {
  const { token, file, config } = completion;
  const claim = crypto.randomUUID();
  let attempt: Attempt = { answer: fail(storeUnavailable()), recorded: false };
  // Set before a deliberate rollback, so an adapter that wraps the thrown error cannot hide which throw it was.
  let rolledBack = false;
  const rollBack = (answer: Answer) => {
    attempt = { answer, recorded: false };
    rolledBack = true;
    throw new Error("cloudrop: rolled back the completion.");
  };
  try {
    await transaction(async (tx, store) => {
      const claimed = await store.claim(token.id, claim, new Date(), config.completionLeaseMs);
      if (claimed.kind !== "claimed") {
        attempt = { answer: claimAnswer(claimed, file), recorded: false };
        return;
      }
      // Only a route made by the store's own route() expects tx; a plain route keeps an authorize field of that name.
      const ran = await runOnComplete(completion, storeOfRoute(completion.route.definition) ? { tx } : {});
      if (ran.error) return rollBack(ran);
      const replace = completion.route.replace;
      const done = await store.complete(token.id, claim, ran.data.json, new Date(), { replace });
      if (!done.changed) return rollBack(lostClaim(done.record, file));
      attempt = { answer: ok({ file, data: ran.data.data }), recorded: true, replaced: done.replaced };
    });
  } catch (error) {
    if (rolledBack) return attempt;
    config.logger.error(`cloudrop: the store failed to complete file ${token.id} on route "${token.route}".`, error);
    return { answer: fail(storeUnavailable()), recorded: false };
  }
  return attempt;
}

/**
 * After a replacing completion is recorded: the replaced files' objects, removed one at a time. A failure is logged and
 * left to the sweep, whose cleanup pass finds the row deleted and not cleaned.
 */
async function removeReplaced({ config }: Completion, store: CloudropStore<unknown>, replaced: readonly FileRecord[]) {
  for (const record of replaced) {
    const removed = await removeDeleted(config, store, record);
    if (removed.error) {
      config.logger.error(
        `cloudrop: could not remove the replaced file ${record.id} from the bucket. The sweep removes it later.`,
        removed.error,
      );
    }
  }
}

/** Best effort and at most once, after the completion is recorded: a throw is logged and the answer stands. */
async function runAfterComplete({ request, config, token, route, file }: Completion, data: unknown): Promise<void> {
  try {
    await route.definition.afterComplete?.({ ...completeContext(request, token, file), data });
  } catch (error) {
    config.logger.error(`cloudrop: afterComplete failed for route "${route.name}".`, error);
  }
}

export async function completeStored(
  { request, config }: EndpointInput,
  store: CloudropStore<unknown>,
  token: UploadTokenPayload,
  route: RouteConfig,
): Promise<Answer> {
  const calls = fileCalls(store, config.logger, token);
  const completion: Completion = { request, config, token, route, file: uploadedFile(config, token, route), calls };
  const row = await calls.get();
  if (row.error) return row;
  const early = answerFromRow(row.data, completion);
  if (early) return early;
  // Storage and plugins run outside any transaction: no network call while a row lock is held.
  const stored = await verifyUpload(config, token);
  const checked = stored.kind === "verified" ? await checkAfterVerify(request, config, token, completion.file) : stored;
  if (checked.kind === "failed") return fail(checked.error);
  if (checked.kind === "refused") return refuse(completion, checked);
  const attempt = store.transaction
    ? await inTransaction(completion, store.transaction.bind(store))
    : await withLease(completion);
  if (attempt.recorded) {
    await removeReplaced(completion, store, attempt.replaced);
    await runAfterComplete(completion, attempt.answer.data?.data);
  }
  return attempt.answer;
}
