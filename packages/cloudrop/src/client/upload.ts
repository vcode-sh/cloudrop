// One file's bytes and its /complete: the bytes as one PUT or as parts, each PUT holding a slot of the client's pool,
// then /complete with up to two repair rounds (decisions S13, S14). file-run.ts decides how the file ends.

import { fail, ok, type Result } from "../errors.ts";
import { sizeOfPart } from "../plan.ts";
import type { CompleteResponse, SignedPart, SignedRequest } from "../protocol/types.ts";
import type { BucketOutcome } from "./bucket.ts";
import type { Endpoints, Ticket } from "./endpoints.ts";
import { aborted } from "./failures.ts";
import type { Entry } from "./file-run.ts";
import { type PartSender, sendParts } from "./parts.ts";
import type { Pool } from "./pool.ts";
import { withRetry } from "./retry.ts";
import type { PutObject } from "./transport.ts";

/** /complete may answer PARTS_MISSING this many times before the file fails (S13). */
const REPAIR_ROUNDS = 2;

export interface UploadContext {
  endpoints: Endpoints;
  put: PutObject;
  /** The client's connection slots: every bucket PUT holds one (spec §4.4). */
  pool: Pool;
  /** The next file's rank in the pool, counting from 1 across the client's uploads (ruling P9). */
  nextRank(): number;
}

function bodyOf(ticket: Ticket, file: File, partNumber: number): Blob {
  if (ticket.kind === "single") return file;
  const start = (partNumber - 1) * ticket.partSize;
  return file.slice(start, start + sizeOfPart(file.size, ticket.partSize, partNumber));
}

interface Upload {
  ticket: Ticket;
  entry: Entry;
}

/** The file moves to `status` and the job hears of it at once. */
function moveTo(entry: Entry, status: "uploading" | "completing"): void {
  entry.status = status;
  entry.changed(true);
}

function senderFor(context: UploadContext, { ticket, entry }: Upload): PartSender {
  const { file, rank } = entry;
  const { signal } = entry.cancel;
  // A slot is held for the PUT alone: it is free again before a retry's wait (spec §4.4). A part still waiting for one
  // when the file is cancelled or has failed never starts; a PUT already sent finishes (spec §6.2).
  const put = async (target: SignedRequest, partNumber: number, stop: AbortSignal): Promise<BucketOutcome> => {
    const release = await context.pool.acquire([rank, partNumber], stop);
    try {
      // `stop` may also fire between the grant and this line: the slot goes back unused (audit I1).
      if (release === null || stop.aborted) return { kind: "aborted", error: aborted() };
      // Never from paused or a settled status (audit I1); a repair after PARTS_MISSING turns completing back.
      if (entry.status === "queued" || entry.status === "completing") {
        // The speed starts from 0 whenever the file starts sending again.
        entry.meter.restart(Date.now());
        moveTo(entry, "uploading");
      }
      const body = bodyOf(ticket, file, partNumber);
      return await context.put(target, body, signal, (sent) => {
        const added = entry.progress.sent(partNumber, sent, body.size);
        if (added === 0) return;
        entry.meter.add(added, Date.now());
        entry.changed(false);
      });
    } finally {
      release?.();
    }
  };
  if (ticket.kind === "multipart") {
    return {
      signal,
      first: ticket.parts,
      put,
      sign: (parts) => context.endpoints.signParts(ticket.token, parts, signal),
    };
  }
  // A single PUT is part 1 of 1, so one routine sends both kinds.
  const sign = async (): Promise<Result<SignedPart[]>> => {
    const renewed = await context.endpoints.signSingle(ticket.token, signal);
    return renewed.error ? renewed : ok([{ partNumber: 1, ...renewed.data }]);
  };
  return { signal, first: [{ partNumber: 1, ...ticket.put }], put, sign };
}

interface Sent {
  result: Result<CompleteResponse<unknown>>;
  /** Some /complete got no answer or a SERVER_ERROR, so the server may have completed the file: a cancel keeps it. */
  mayBeComplete: boolean;
}

export async function sendAndComplete(context: UploadContext, upload: Upload): Promise<Sent> {
  const { ticket, entry } = upload;
  const sender = senderFor(context, upload);
  let parts = Array.from({ length: ticket.kind === "single" ? 1 : ticket.partCount }, (_, index) => index + 1);
  let mayBeComplete = false;
  // Without the signal: the server may finish a /complete (and run onComplete) after the browser stopped waiting (S14).
  const complete = async (): Promise<Result<CompleteResponse<unknown>>> => {
    const done = await context.endpoints.complete(ticket.token);
    const code = done.error?.code;
    // PARTS_MISSING clears the doubt wherever it arrives: the server sends it only while the multipart upload is still
    // open, so no earlier /complete finished the file and /abort deletes nothing recorded (ruling S-9).
    if (code === "PARTS_MISSING") mayBeComplete = false;
    // Otherwise sticky: a later answer does not undo an earlier /complete that may have finished (S14, M3-H16).
    else mayBeComplete ||= code === "NETWORK_ERROR" || code === "SERVER_ERROR";
    return done;
  };
  for (let round = 0; ; round++) {
    const sent = await sendParts(sender, parts);
    if (sent.error) return { result: fail(sent.error), mayBeComplete };
    moveTo(entry, "completing");
    const done = await withRetry(complete, entry.cancel.signal);
    const missing = done.error?.code === "PARTS_MISSING" ? done.error.parts : undefined;
    if (!missing?.length || round === REPAIR_ROUNDS) return { result: done, mayBeComplete };
    parts = [...missing];
  }
}
