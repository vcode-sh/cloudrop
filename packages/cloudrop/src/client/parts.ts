// Sends the parts of one multipart upload: four at a time, signing the parts the ticket did not cover lazily, renewing
// URLs that expire, retrying within one budget and stopping on cancel (decisions S11, S12; spec §6.1, §6.2).

import { type CloudropError, fail, ok, type Result } from "../errors.ts";
import { PARTS_PER_SIGN, type SignedPart, type SignedRequest } from "../protocol/types.ts";
import type { BucketOutcome } from "./bucket.ts";
import { aborted, unreadableAnswer } from "./failures.ts";
import { MAX_ATTEMPTS, pause, retryDelay } from "./retry.ts";

/** At most this many parts of one file in flight (spec §6.1). */
export const PARTS_IN_FLIGHT: number = 4;

export interface PartSender {
  signal: AbortSignal;
  /** The URLs the /upload ticket carried. */
  first: readonly SignedPart[];
  /** POST /sign for these parts; the answer holds exactly them (answers.ts checks it). */
  sign(partNumbers: readonly number[]): Promise<Result<SignedPart[]>>;
  /** PUT this part's bytes to the URL. */
  put(target: SignedRequest, partNumber: number): Promise<BucketOutcome>;
}

export type Step =
  | { kind: "done" }
  | { kind: "fail"; error: CloudropError }
  | { kind: "again"; renew: boolean; waitMs: number };

/** A URL with less time left than this by the client's clock is renewed before it is used (S11). */
const RENEW_MARGIN_MS = 60_000;

interface Run {
  sender: PartSender;
  partNumbers: readonly number[];
  urls: Map<number, SignedRequest>;
  /** The /sign call that workers reaching unsigned parts share. */
  batch: Promise<CloudropError | null> | null;
}

const expiresSoon = (target: SignedRequest): boolean => Date.parse(target.expiresAt) - Date.now() < RENEW_MARGIN_MS;

/** A /sign failure, seen as the outcome of a part's attempt so one budget covers both. */
function signFailure(error: CloudropError): BucketOutcome {
  if (error.code === "ABORTED") return { kind: "aborted", error };
  return error.retryable ? { kind: "retry", error, retryAfterMs: 0 } : { kind: "rejected", error };
}

/** What to do after an attempt: `attempt` is its number, `renewed` whether this part's URL was already renewed. */
export function nextStep(outcome: BucketOutcome, attempt: number, renewed: boolean): Step {
  if (outcome.kind === "stored") return { kind: "done" };
  // Rejected or aborted: the outcomes without a wait (`kind` alone cannot narrow their shared union member).
  if (!("retryAfterMs" in outcome)) return { kind: "fail", error: outcome.error };
  // A renewed URL refused as expired again will not get better (S11).
  if (attempt >= MAX_ATTEMPTS || (outcome.kind === "expired" && renewed)) return { kind: "fail", error: outcome.error };
  // A failure the browser hides (an expired R2 URL answers without CORS headers) or a readable expiry: new URL, once.
  const renew = (outcome.kind === "opaque" || outcome.kind === "expired") && !renewed;
  // A readable expiry is retried at once with the new URL; every other failure waits first (spec §6.2).
  const waitMs = renew && outcome.kind === "expired" ? 0 : retryDelay(attempt, outcome.retryAfterMs);
  return { kind: "again", renew, waitMs };
}

/** Signs `partNumber` and the next unsigned parts, at most PARTS_PER_SIGN, in one call that waiting workers share. */
function signAhead(run: Run, partNumber: number): Promise<CloudropError | null> {
  if (run.batch) return run.batch;
  const unsigned = run.partNumbers.filter((n) => n !== partNumber && !run.urls.has(n));
  const call = run.sender.sign([partNumber, ...unsigned].slice(0, PARTS_PER_SIGN)).then((signed) => {
    run.batch = null;
    if (signed.error) return signed.error;
    for (const part of signed.data) run.urls.set(part.partNumber, part);
    return null;
  });
  run.batch = call;
  return call;
}

async function urlFor(run: Run, partNumber: number, renew: boolean): Promise<Result<SignedRequest>> {
  let known = run.urls.get(partNumber);
  // A batch that did not include this part (another worker started it) is followed by one that does.
  while (known === undefined) {
    const error = await signAhead(run, partNumber);
    if (error) return fail(error);
    known = run.urls.get(partNumber);
  }
  if (!renew && !expiresSoon(known)) return ok(known);
  const renewed = await run.sender.sign([partNumber]);
  if (renewed.error) return renewed;
  const [part] = renewed.data;
  if (part === undefined) return fail(unreadableAnswer(200)); // unreachable: answers.ts checked the parts
  run.urls.set(partNumber, part);
  return ok(part);
}

async function sendPart(run: Run, partNumber: number): Promise<CloudropError | null> {
  let renew = false;
  let renewed = false;
  for (let attempt = 1; ; attempt++) {
    if (run.sender.signal.aborted) return aborted();
    const target = await urlFor(run, partNumber, renew);
    // urlFor may have waited for a /sign; the upload may have been cancelled meanwhile.
    if (run.sender.signal.aborted) return aborted();
    const outcome = target.error ? signFailure(target.error) : await run.sender.put(target.data, partNumber);
    const step = nextStep(outcome, attempt, renewed);
    if (step.kind === "done") return null;
    if (step.kind === "fail") return step.error;
    renew = step.renew;
    renewed ||= step.renew;
    await pause(step.waitMs, run.sender.signal);
  }
}

/** Sends `partNumbers` (ascending), at most PARTS_IN_FLIGHT at a time. The first part that fails for good fails the call. */
export async function sendParts(sender: PartSender, partNumbers: readonly number[]): Promise<Result<void>> {
  const run: Run = {
    sender,
    partNumbers,
    urls: new Map(sender.first.map((part) => [part.partNumber, part])),
    batch: null,
  };
  const queue = [...partNumbers];
  let failure: CloudropError | null = null;
  // The first part that fails for good stops new parts; parts in flight finish (spec §6.2).
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined && failure === null; next = queue.shift()) {
      // Read before `failure ??=`: `failure ??= await sendPart(…)` would test `failure` before the await and let a
      // later success overwrite another worker's failure with null.
      const error = await sendPart(run, next);
      failure ??= error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARTS_IN_FLIGHT, queue.length) }, worker));
  return failure ? fail(failure) : ok(undefined);
}
