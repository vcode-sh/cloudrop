// What a route's callbacks receive: the authorize result beside the fields cloudrop sets on every context.

import type { Jsonified, UploadedFile } from "../protocol/types.ts";

/**
 * Names cloudrop puts, or may put, into a route context: an authorize result may not use them (M12-A8), so a context
 * field added after 1.0 cannot collide with an app's own. At runtime cloudrop's fields still win.
 */
export type ReservedName = "request" | "metadata" | "file" | "data" | "tx" | "route" | "signal";

/** An authorize result: a plain object without any reserved name. */
export type AuthResult = object & { [K in ReservedName]?: never };

export interface AuthorizeContext<TMetadata> {
  /**
   * The request as the handler received it, for its headers (cookies, `authorization`) and `url`. Its body is already
   * read, so `request.json()` and `request.text()` throw: what the client sent is in `metadata`.
   */
  request: Request;
  metadata: TMetadata;
}

/** `owner` sees the live authorize result inside `/upload`, once for all of its files. */
export type OwnerContext<TAuth, TMetadata> = Omit<TAuth, ReservedName> & AuthorizeContext<TMetadata>;

/** `prefix` and `key` see the live authorize result; this runs inside `/upload`, once per file. */
export type KeyContext<TAuth, TMetadata> = OwnerContext<TAuth, TMetadata> & {
  file: { id: string; name: string; size: number; type: string; ext: string };
};

/** `onComplete` runs inside `/complete`, so it sees what the token carried: the JSON form of each value. */
export type CompleteContext<TAuth, TMetadata> = Omit<Jsonified<TAuth>, ReservedName> & {
  /**
   * The `/complete` request, for its headers (cookies, `authorization`) and `url`. Its body, the upload token, is
   * already read, so `request.json()` and `request.text()` throw: the upload is in `file` and `metadata`.
   */
  request: Request;
  file: UploadedFile;
  /** undefined on a route without a schema, and possibly undefined when the schema's output can be. */
  metadata: Jsonified<TMetadata> | (undefined extends TMetadata ? undefined : never);
};

/** What `/complete` sends as `data`: the JSON form of the result, and null where `onComplete` gave undefined or nothing. */
export type CompleteData<TResult> = Jsonified<TResult> | (undefined extends TResult ? null : never);

/** `afterComplete` sees what `onComplete` sees, plus the `data` the client was sent. */
export type AfterCompleteContext<TAuth, TMetadata, TResult> = CompleteContext<TAuth, TMetadata> & {
  data: CompleteData<Awaited<TResult>>;
};
