// What a page keeps of a multipart upload while it holds the upload's ticket (resume spec §3.1, §3.2, §3.5): a record
// in the browser's store, so that the upload can resume after a reload, and the upload's Web Lock, so that no other
// holder sends it meanwhile. Both are taken when the ticket arrives, from start(), upload() or a retry's new ticket, and
// both go when the page gives the ticket up (audit C2, I5), through letGo:
// - the file ends done (runFile);
// - its /abort is sent (drop): a cancel, abort() or the job's signal on a failed file, and the failure of a single PUT
//   in upload() or at pagehide; the lock is let go only once the /abort is answered, so no other tab completes what
//   it then deletes;
// - a cancel, or abort() of a failed file, when a /complete may have finished it and no /abort is sent (end, abortFile);
// - a retry's new ticket replaces it (requeue).
// A failed file of start() keeps both, for retry(). A failed multipart file of upload(), and one of start() at pagehide,
// keeps its record for a resume after a reload and lets the lock go, sending no /abort (giveUp, M4-F1); so does one of
// upload() that a /complete may have finished: this page has no handle to send it again (ruling M3-U82).

import type { Ticket } from "./endpoints.ts";
import type { Entry } from "./file-run.ts";
import { fingerprintOf } from "./fingerprint.ts";
import type { Job } from "./job-run.ts";
import { lockUpload } from "./locks.ts";
import type { Upload, UploadContext } from "./upload.ts";

/** `entry`'s upload under the ticket that just arrived; a persisted one is locked at once, and saved once locked. */
export function uploadOf({ context, args }: Job, entry: Entry, ticket: Ticket): Upload {
  const { records, namespace } = context;
  // A single PUT cannot resume, and with persistence off nothing could resume it: neither is saved nor locked. The
  // upload does not wait for the lock: no other holder can know an id /upload just made (ruling M3-U81).
  let unlock = () => {};
  if (ticket.kind === "multipart" && records.enabled) {
    const lock = lockUpload(ticket.id);
    unlock = lock.release;
    const { file } = entry;
    // Queued now, while the lock is asked for and then the file's edges are hashed: a letGo of a file that ends at once
    // is queued after it (M3-U80). Saved only under the lock (M3-U88): a record no lock guards could be resumed while
    // this page still holds the ticket, whose /abort would then delete the finished object. A refused lock, or a file
    // the browser can no longer read, rejects, and the store drops the save.
    records.save(
      lock.taken
        .then((taken) => (taken ? fingerprintOf(file) : Promise.reject()))
        .then((fingerprint) => ({
          id: ticket.id,
          namespace,
          route: args.route,
          // What /upload received: a structured clone would keep what JSON leaves out, and throw on a function (I12).
          metadata: args.metadata === undefined ? undefined : JSON.parse(JSON.stringify(args.metadata)),
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          fingerprint,
          token: ticket.token,
          key: ticket.key,
          partSize: ticket.partSize,
          partCount: ticket.partCount,
          expiresAt: ticket.expiresAt,
          savedAt: Date.now(),
        })),
    );
  }
  return { ticket, entry, mayBeComplete: false, repairs: 0, dropped: false, unlock, probe: false };
}

/**
 * The page gives `upload`'s ticket up: its record is deleted at once and its lock let go, once `answered` settles when
 * given (an /abort in flight, which never rejects). Again, it changes nothing.
 */
export function letGo(context: UploadContext, upload: Upload, answered?: Promise<void>): void {
  if (upload.ticket.kind === "multipart") context.records.remove(upload.ticket.id);
  if (answered) void answered.then(upload.unlock);
  else upload.unlock();
}
