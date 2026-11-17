// One pass of a file: the bytes that have not landed as one PUT or as parts, each PUT holding a slot of the client's
// pool, then /complete with up to two repair rounds (decisions S13, S14). file-run.ts runs the passes and decides how
// the file ends.

import { fail, ok, type Result } from "../errors.ts";
import { sizeOfPart } from "../part-size.ts";
import type { CompleteResponse, MultipartTicket, SignedPart, SignedRequest } from "../protocol/types.ts";
import type { BucketOutcome } from "./bucket.ts";
import type { Endpoints, Ticket } from "./endpoints.ts";
import type { Entry } from "./entry.ts";
import { aborted } from "./failures.ts";
import type { Leftovers } from "./lifecycle.ts";
import { type PartSender, sendParts } from "./parts.ts";
import type { Pool } from "./pool.ts";
import type { Records } from "./records.ts";
import { withRetry } from "./retry.ts";
import type { PutObject } from "./transport.ts";

/** /complete may answer PARTS_MISSING this many times before the file fails (S13). */
const REPAIR_ROUNDS = 2;

export interface UploadContext {
  endpoints: Endpoints;
  put: PutObject;
  /** The client's connection slots: every bucket PUT holds one (spec §4.4). */
  pool: Pool;
  /** Which waiting PUTs the pool grants first: the earlier file's, or the smaller file's (spec §4.4). */
  order: "added" | "smallest-first";
  /** The next file's rank in the pool, counting from 1 across the client's uploads (ruling M3-U9). */
  nextRank(): number;
  /** The failed files' tickets that pagehide frees (ruling M3-U33). */
  leftovers: Leftovers;
  /**
   * A failed file keeps its ticket and parts for retry(): start() jobs; upload() has no handle to retry with
   * (M3-U29).
   */
  keepFailed: boolean;
  /** The browser's store of unfinished multipart uploads (resume spec §3.1); a no-op one with persistence off. */
  records: Records;
  /** Keeps one signed-in user's records apart from another's (ruling M3-U79). */
  namespace: string;
  /**
   * One claim per holder of an upload: a ticket, from its arrival to its unlock, and a resume, from resume() to its
   * refusal or its upload's unlock. resumable() leaves out every upload with a claim (M4-F22).
   */
  claims: Set<{ id: string }>;
}

/**
 * Claims upload `id` until the returned function is called; again, it does nothing. Each holder releases only its own
 * claim, so two holders of one upload, such as two resumes in flight, never release each other's (M4-F22).
 */
export function claim({ claims }: UploadContext, id: string): () => void {
  const made = { id };
  claims.add(made);
  return () => claims.delete(made);
}

function bodyOf(ticket: Ticket, file: File, partNumber: number): Blob {
  if (ticket.kind === "single") return file;
  const start = (partNumber - 1) * ticket.partSize;
  return file.slice(start, start + sizeOfPart(file.size, ticket.partSize, partNumber));
}

/** A file's upload under one ticket, across its passes and same-ticket retries. */
export interface Upload {
  readonly ticket: Ticket;
  readonly entry: Entry;
  /** Some /complete got no answer or a SERVER_ERROR, so the server may have completed the file: a cancel keeps it. */
  mayBeComplete: boolean;
  /** The PARTS_MISSING repair rounds started so far. */
  repairs: number;
  /**
   * The page gave its ticket up: its /abort was sent, or a reload may resume it (giveUp, M4-F1). A retry needs a new
   * ticket, and no /abort follows (M3-U33).
   */
  dropped: boolean;
  /** Lets go of the upload's Web Lock, held while the page keeps the ticket (M3-U73); a no-op when none was taken. */
  unlock(): void;
  /**
   * Rebuilt from a record by resume() and still waiting for its probe's first answer that lists what landed: success
   * or PARTS_MISSING (resume spec §3.4). Until then every part counts as landed and no byte as sent.
   */
  probe: boolean;
  /** Every URL signed for it so far (PartSender.urls). */
  readonly urls: Map<number, SignedRequest>;
}

/** `entry`'s upload under `ticket`, from its first pass; `probe` when resume() rebuilt it from a record. */
export function newUpload(ticket: Ticket, entry: Entry, unlock: () => void, probe = false): Upload {
  // A single PUT is part 1 of 1, so one routine sends both kinds.
  const signed = ticket.kind === "single" ? [{ partNumber: 1, ...ticket.put }] : ticket.parts;
  const urls = new Map(signed.map((part) => [part.partNumber, part]));
  return { ticket, entry, mayBeComplete: false, repairs: 0, dropped: false, unlock, probe, urls };
}

/** The file moves to `status` and the job hears of it at once. Sending starts the speed from 0. */
function moveTo(entry: Entry, status: "uploading" | "completing"): void {
  if (status === "uploading") entry.meter.restart(Date.now());
  entry.status = status;
  entry.changed(true);
}

/** Sends through `signal`, the pass's: a pause or a cancel aborts the PUTs and /sign calls in flight. */
function senderFor(context: UploadContext, { ticket, entry, urls }: Upload, signal: AbortSignal): PartSender {
  const { file, rank } = entry;
  const { pool } = context;
  // A slot is held for the PUT alone: it is free again before a retry's wait (spec §4.4). A part still waiting for one
  // when the file is cancelled or has failed never starts; a PUT already sent finishes (spec §6.2).
  const put = async (target: SignedRequest, partNumber: number, stop: AbortSignal): Promise<BucketOutcome> => {
    const place = context.order === "smallest-first" ? [file.size, rank, partNumber] : [rank, partNumber];
    const release = await pool.acquire(place, stop);
    try {
      // `stop` may also fire between the grant and this line: the slot goes back unused (ruling M3-U21).
      if (release === null || stop.aborted) return { kind: "aborted", error: aborted() };
      // Never from paused or a settled status (ruling M3-U21): those abort the pass, and `stop` with it.
      if (entry.status === "queued") moveTo(entry, "uploading");
      const body = bodyOf(ticket, file, partNumber);
      const outcome = await context.put(target, body, signal, (sent) => {
        // Only bytes above this part's earlier best: a retry sending them again is no throughput.
        const added = entry.progress.sent(partNumber, sent, body.size);
        if (added === 0) return;
        pool.sent(added);
        entry.meter.add(added, Date.now());
        entry.changed(false);
      });
      if (outcome.kind === "stored") entry.landed.add(partNumber);
      // Before the release below, so the slot it frees goes back to a pool already halved (ruling M3-U45).
      if (outcome.kind === "opaque" || (outcome.kind === "retry" && outcome.error.code === "RATE_LIMITED")) {
        pool.slowDown();
      }
      return outcome;
    } finally {
      release?.();
    }
  };
  if (ticket.kind === "multipart") {
    return { signal, urls, put, sign: (parts) => context.endpoints.signParts(ticket.token, parts, signal) };
  }
  const sign = async (): Promise<Result<SignedPart[]>> => {
    const renewed = await context.endpoints.signSingle(ticket.token, signal);
    return renewed.error ? renewed : ok([{ partNumber: 1, ...renewed.data }]);
  };
  return { signal, urls, put, sign };
}

/**
 * A resumed upload's probe got `done`. Its first answer that lists what landed, success or PARTS_MISSING naming
 * `missing`, ends the probe: the parts it did not name count their whole size from now; no byte flowed, so neither the
 * pool nor the speed hears of them (M3-U75, audit I3). That PARTS_MISSING is the list of what is left, not a repair:
 * it takes no repair round. Any other answer leaves the probe for a retry to send again.
 */
function probed(upload: Upload, done: Result<unknown>, missing: readonly number[] | undefined): void {
  if (done.error && !missing) return;
  const { entry, ticket } = upload;
  upload.probe = false;
  // Only a multipart ticket is probed: each size comes from the plan, without slicing the file (final review M2).
  const { partSize } = ticket as MultipartTicket;
  // A Set: 0.6 ms instead of 20 ms for an array at 10,000 parts with 9,000 missing (M4-F7).
  const lacking = new Set(missing);
  for (const part of entry.landed) {
    const size = sizeOfPart(entry.file.size, partSize, part);
    if (!lacking.has(part)) entry.progress.sent(part, size, size);
  }
  // The caller counts a repair round for this answer next: given back here.
  if (missing) upload.repairs--;
}

/** Sends the parts that have not landed and completes the file. ABORTED when `signal` (the pass's) fired first. */
export async function sendAndComplete(
  context: UploadContext,
  upload: Upload,
  signal: AbortSignal,
): Promise<Result<CompleteResponse<unknown>>> {
  const { ticket, entry } = upload;
  const sender = senderFor(context, upload, signal);
  const partNumbers = Array.from({ length: ticket.kind === "single" ? 1 : ticket.partCount }, (_, index) => index + 1);
  // Without the signal: the server may finish a /complete (and run onComplete) after the browser stopped waiting (S14).
  const complete = async (): Promise<Result<CompleteResponse<unknown>>> => {
    const done = await context.endpoints.complete(ticket.token);
    const code = done.error?.code;
    // PARTS_MISSING clears the doubt wherever it arrives: the server sends it only while the multipart upload is still
    // open, so no earlier /complete finished the file and /abort deletes nothing recorded (ruling S-9). NO_SUCH_UPLOAD
    // too: the server sends it once it found the upload gone and no object of it stored (server/complete.ts, M3-U83).
    if (code === "PARTS_MISSING" || code === "NO_SUCH_UPLOAD") upload.mayBeComplete = false;
    // Otherwise sticky: a later answer does not undo an earlier /complete that may have finished (S14, M3-H16).
    else upload.mayBeComplete ||= code === "NETWORK_ERROR" || code === "SERVER_ERROR";
    return done;
  };
  for (;;) {
    const unsent = partNumbers.filter((partNumber) => !entry.landed.has(partNumber));
    const sent = await sendParts(sender, unsent);
    if (sent.error) return fail(sent.error);
    // Paused after the last part landed: /complete waits for the next pass, which sends nothing first.
    if (signal.aborted) return fail(aborted());
    moveTo(entry, "completing");
    const done = await withRetry(complete, entry.cancel.signal);
    const missing = done.error?.code === "PARTS_MISSING" ? done.error.parts : undefined;
    if (upload.probe) probed(upload, done, missing);
    // A cancel during /complete ends the file with this answer rather than start a repair (M4-F4).
    if (!missing?.length || upload.repairs === REPAIR_ROUNDS || entry.cancel.signal.aborted) return done;
    upload.repairs++;
    for (const partNumber of missing) entry.landed.delete(partNumber);
    // Uploading again at once, so a pause applies to the repair (ruling M3-U4).
    moveTo(entry, "uploading");
  }
}
