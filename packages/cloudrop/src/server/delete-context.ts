// What a route's onDelete hook receives (M10-D4, M10-D12), typed per route from its parameter's annotation (M12-T6).

import type { FileRecord } from "./store.ts";

/** What deleted a completed file: `api.deleteFile`, a `replace: true` completion, or `api.eraseOwner`. */
export type DeleteReason = "deleted" | "replaced" | "erased";

/** What every onDelete call receives, whatever deleted the file. */
export interface DeleteBase {
  /** The file's row as it was before the deletion, so `status` is `"completed"`. */
  file: FileRecord;
  /** The file's owner, as `owner()` answered at `/upload`; null for a file without one. */
  owner: string | null;
}

/**
 * A route's `onDelete` runs for a stored file outside any request: it sees the file's row, not an authorize result.
 * `context` is what the caller passed to `api.deleteFile` (`TDeleted`) or `api.eraseOwner` (`TErased`), such as who
 * asked and why, for an audit row. Annotate the hook's parameter, `DeleteContext<FileDeleter>`, and those calls require
 * a context of that type; without an annotation it is `unknown` and optional. A replacement gets the replacing
 * upload's `/complete` request instead, whose body is already read, so `request.json()` and `request.text()` throw.
 */
export type DeleteContext<TDeleted = unknown, TErased = TDeleted> = DeleteBase &
  (
    | { reason: "deleted"; context: TDeleted; request?: undefined }
    | { reason: "erased"; context: TErased; request?: undefined }
    | { reason: "replaced"; context: undefined; request: Request }
  );

/** The `context` option: required when the routes' onDelete declares a type for it that does not admit undefined. */
export type ContextOption<TContext> = undefined extends TContext
  ? {
      /** Passed to the route's `onDelete` as `context`, as it is: who asked and why, for an audit row. */
      context?: TContext;
    }
  : {
      /** Passed to the route's `onDelete` as `context`, as it is: who asked and why, for an audit row. */
      context: TContext;
    };
