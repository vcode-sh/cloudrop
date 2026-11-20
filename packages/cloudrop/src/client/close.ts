// close() (M7-P3, rulings M8-L1 to M8-L4): the client starts nothing more, and every job it runs stops. Without
// `abort` it lets each upload go as a closing tab does, so the same user can resume after signing in again; with it,
// each file is cancelled as job.abort() cancels it, which tells the server, for sign-out.

import type { Job } from "./job-run.ts";
import type { Upload, UploadContext } from "./upload.ts";

/** What close() reads and sets, shared by every copy of a client's context, as its claims are. */
export interface Lifetime {
  /** Set by the first close(), which decides for every later one (M8-L3). */
  closed: { abort: boolean } | null;
  /** The jobs with a file that may still send or be retried: close() stops each (M8-L2). */
  readonly jobs: Set<Job>;
}

export const createLifetime = (): Lifetime => ({ closed: null, jobs: new Set() });

export function closeClient({ lifetime }: UploadContext, abort: boolean): void {
  if (lifetime.closed) return;
  lifetime.closed = { abort };
  // A job leaves the set once no file of it can send again, also while this loop runs.
  for (const job of lifetime.jobs) job.abort();
}

/**
 * After close() without `abort`, lets a cancelled `upload` go as a closing tab would (M8-L2): a multipart upload a
 * reload can resume keeps its record and sends no /abort, and its lock goes, so a new client in this page can resume
 * it. True when it did; otherwise the caller ends the upload as any cancel does.
 */
export function keptForResume(context: UploadContext, upload: Upload): boolean {
  const keeping = context.lifetime.closed?.abort === false;
  if (!keeping || upload.ticket.kind !== "multipart" || !context.records.enabled) return false;
  upload.dropped = true;
  upload.unlock();
  return true;
}
