// discard(upload) (decisions M3-U93, M3-U94): drops one unfinished upload that resumable() listed, without its file.
// Under the upload's lock, as a resume would run it, the record's own token is sent to /abort with `keep`, which aborts
// an unfinished multipart upload and, with a store, ends its row and frees its reservation, but never deletes an object
// that landed: a /complete may have finished the upload while the page heard nothing (M3-U82, M3-H16). Then the record
// is deleted and, once that delete has run, the lock let go.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput } from "../input.ts";
import { lockRefused, NEEDS_NEW_TICKET, notListed, uploadInUse } from "./failures.ts";
import { lockUpload } from "./locks.ts";
import { EXPIRY_MARGIN_MS } from "./records.ts";
import { claim, type UploadContext } from "./upload.ts";

/** True when `expiresAt` is within the margin that makes resumable() delete a record as expired (M3-U72). */
const expired = (expiresAt: unknown): boolean =>
  typeof expiresAt === "string" && Date.parse(expiresAt) - EXPIRY_MARGIN_MS <= Date.now();

export async function discard(context: UploadContext, upload: unknown): Promise<Result<{ aborted: boolean }>> {
  const { id, expiresAt } = (upload ?? {}) as { id?: unknown; expiresAt?: unknown };
  if (typeof id !== "string") return fail(invalidInput("Pass discard() an upload from resumable()."));
  // Claimed before the first await, as a resume claims (M4-F22): resumable() leaves it out from now on.
  const release = claim(context, id);
  try {
    const { data, error } = await context.records.list(context.namespace);
    if (error) return fail(error);
    const record = data.find((saved) => saved.id === id);
    // An expired record was deleted by that read, its token with it: there is nothing to send /abort with.
    if (!record) return expired(expiresAt) ? ok({ aborted: false }) : fail(notListed());
    const lock = lockUpload(id);
    const taken = await lock.taken;
    // Another holder may complete it, and an /abort would then delete the finished object (M3-U73). Where the browser
    // refuses Web Locks, nothing that needs one runs (M3-U88).
    if (!taken) return fail(taken === false ? uploadInUse() : lockRefused());
    try {
      // The server takes an expired token for /abort, so a record still listed can always be aborted (spec §5.5).
      const answer = await context.endpoints.abort(record.token, { keep: true });
      // A token the server refuses for good cannot abort anything, now or later; any other failure may pass on another
      // try, so the record stays for it.
      if (answer.error && !NEEDS_NEW_TICKET.has(answer.error.code)) return fail(answer.error);
      // Deleted before the lock goes, so no other tab finds the record free in between. Its result is not read: the
      // server's part is done, and a record that survives a failed delete is aborted again harmlessly.
      await context.records.remove(id);
      return ok({ aborted: answer.error === null });
    } finally {
      lock.release();
    }
  } finally {
    release();
  }
}
