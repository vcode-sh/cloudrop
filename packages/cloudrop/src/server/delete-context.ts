// What a route's onDelete hook receives (M10-D4, M10-D12).

import type { FileRecord } from "./store.ts";

/** What deleted a completed file: `api.deleteFile`, a `replace: true` completion, or `api.eraseOwner`. */
export type DeleteReason = "deleted" | "replaced" | "erased";

/** A route's `onDelete` runs for a stored file outside any request: it sees the file's row, not an authorize result. */
export interface DeleteContext {
  /** The file's row as it was before the deletion, so `status` is `"completed"`. */
  file: FileRecord;
  /** The file's owner, as `owner()` answered at `/upload`; null for a file without one. */
  owner: string | null;
  reason: DeleteReason;
  /**
   * What the caller passed as `context` to `api.deleteFile` or `api.eraseOwner`, such as who asked and why, for an audit
   * row; undefined when it passed none, and for a replacement.
   */
  context: unknown;
  /**
   * The `/complete` request of the upload that replaces this file, for its headers and `url`; only with
   * `reason: "replaced"`. Its body is already read, so `request.json()` and `request.text()` throw.
   */
  request?: Request;
}
