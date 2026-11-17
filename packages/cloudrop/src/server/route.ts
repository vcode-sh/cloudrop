import { CloudropError, configError } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import type { Jsonified, UploadedFile } from "../protocol/types.ts";
import type { SchemaInput, SchemaOutput, StandardSchema } from "./schema.ts";
import type { Size } from "./size.ts";

export type Awaitable<T> = T | Promise<T>;

// Symbol.for, not Symbol(): two copies of cloudrop in one app must recognise each other's refusals, or one would read
// as a signed-in user.
const DENIED: unique symbol = Symbol.for("cloudrop.unauthorized");

/**
 * Returned by `authorize` to refuse an upload: `unauthorized()` answers UNAUTHORIZED (401), `forbidden()` FORBIDDEN
 * (403), with `message`.
 */
export interface Refusal {
  readonly [DENIED]: true;
  /** Absent on a refusal from a copy of cloudrop that predates forbidden(): it means UNAUTHORIZED. */
  readonly code?: "UNAUTHORIZED" | "FORBIDDEN";
  readonly message: string;
}

/** For a caller who is not signed in. */
export function unauthorized(message = "Sign in to upload files here."): Refusal {
  return { [DENIED]: true, code: "UNAUTHORIZED", message };
}

/** For a signed-in caller who may not upload this: a quota, a plan or a role. */
export function forbidden(message = "You are not allowed to upload files here."): Refusal {
  return { [DENIED]: true, code: "FORBIDDEN", message };
}

/** Only a plain object carrying the brand refuses: a Response or an Error is never read as a refusal or as a user. */
export function isRefusal(value: unknown): value is Refusal {
  return isPlainObject(value) && (value as Partial<Refusal>)[DENIED] === true;
}

/** A refusal built by plain JavaScript or another copy of cloudrop may lack a code or a message; it still refuses. */
export function refusalError(refusal: Refusal): CloudropError {
  const forbids = refusal.code === "FORBIDDEN";
  const fallback = forbids ? forbidden() : unauthorized();
  const message = typeof refusal.message === "string" && refusal.message !== "" ? refusal.message : fallback.message;
  return new CloudropError(forbids ? "FORBIDDEN" : "UNAUTHORIZED", message);
}

/** `authorize: allowAnyone` makes a route public. It must be written out: public uploads are never a default. */
export function allowAnyone(): object {
  return {};
}

/** Names cloudrop puts into every route context; an authorize result's own fields with these names are replaced. */
type ReservedName = "request" | "metadata" | "file";

export interface AuthorizeContext<TMetadata> {
  request: Request;
  metadata: TMetadata;
}

/** `prefix` and `key` see the live authorize result; this runs inside `/upload`. */
export type KeyContext<TAuth, TMetadata> = Omit<TAuth, ReservedName> & {
  request: Request;
  metadata: TMetadata;
  file: { id: string; name: string; size: number; type: string; ext: string };
};

/** `onComplete` runs inside `/complete`, so it sees what the token carried: the JSON form of each value. */
export type CompleteContext<TAuth, TMetadata> = Omit<Jsonified<TAuth>, ReservedName> & {
  request: Request;
  file: UploadedFile;
  /** undefined on a route without a schema, and possibly undefined when the schema's output can be. */
  metadata: Jsonified<TMetadata> | (undefined extends TMetadata ? undefined : never);
};

/** What `/complete` sends as `data`: the JSON form of the result, and null where `onComplete` gave undefined or nothing. */
type CompleteData<TResult> = Jsonified<TResult> | (undefined extends TResult ? null : never);

/** route()'s first argument: every option that is not typed from authorize's result. */
export interface RoutePolicy<TAuth extends object, TSchema extends StandardSchema | undefined> {
  /** MIME types such as "image/png", "image/*" or "*\/*". The file name's extension must agree with the type. */
  accept: string | readonly string[];
  /** Bytes, or "5MB" style (binary units). */
  maxSize: Size;
  /** Files per `/upload` call, 1 to 100. Default 10. */
  maxFiles?: number;
  /** Any Standard Schema (zod, valibot, arktype). Its output, as JSON, must fit in 2 KiB. */
  metadata?: TSchema;
  /** "public" needs the storage's `publicUrl`. Default: "public" when the storage has one, otherwise "private". */
  visibility?: "public" | "private";
  /**
   * Required. Return a plain object with the facts later steps need (they are signed into the upload token, which the
   * browser can read: return ids, never secrets), or `unauthorized()` or `forbidden()`. `allowAnyone` makes the route
   * public.
   *
   * It runs only in `/upload`. The token it signs is the authority for the next 24 hours, so a session revoked
   * mid-upload can still finish that upload; check the session again in `onComplete` when that matters.
   */
  authorize: (context: AuthorizeContext<SchemaOutput<TSchema>>) => Awaitable<TAuth | Refusal>;
}

/**
 * route()'s second argument: the callbacks typed from authorize's result. A separate argument because TypeScript
 * infers from callbacks left to right within one object, so one written before authorize would see `object`.
 */
export interface RouteCallbacks<TAuth extends object, TMetadata, TResult> {
  /** Folder for generated keys `<prefix>/<ulid><ext>`. Sanitized like every key. */
  prefix?: (context: KeyContext<TAuth, TMetadata>) => string;
  /**
   * The whole key instead of `<prefix>/<ulid><ext>`. Sanitized like every key. It must be unique: a rejected or
   * aborted upload's object is deleted by key once a HEAD, or a create-only completion, shows the object is this
   * upload's. The delete is not conditional, so another file stored under the same key between the two requests
   * would be deleted.
   */
  key?: (context: KeyContext<TAuth, TMetadata>) => string;
  /**
   * Runs inside `/complete`, at least once per file; its JSON result reaches the client as `data`.
   *
   * `authorize` is not called again here: `request` carries the caller's cookies and headers, so re-check a session
   * that may have been revoked since `/upload`. Until the token expires (24 hours after `/upload`), whoever holds it
   * can also delete this file through `/abort`, even after `onComplete` has run. The 1.1 database adapters close that
   * gap for completed files.
   */
  onComplete?: (context: CompleteContext<TAuth, TMetadata>) => Awaitable<TResult>;
}

/**
 * A route with its types erased, as the server runs it. Method syntax makes the typed callbacks assignable: route()
 * has already checked each one against its own context type.
 */
export interface RouteDefinition {
  accept: string | readonly string[];
  maxSize: Size;
  maxFiles?: number;
  metadata?: StandardSchema;
  visibility?: "public" | "private";
  authorize(context: AuthorizeContext<unknown>): Awaitable<unknown>;
  prefix?(context: KeyContext<object, unknown>): string;
  key?(context: KeyContext<object, unknown>): string;
  onComplete?(context: { request: Request; file: UploadedFile; metadata: unknown }): unknown;
}

export interface Route<TMetadataInput = unknown, TResult = unknown> {
  readonly definition: RouteDefinition;
  /** Type-only: never set at runtime. */
  readonly "~types"?: { readonly metadata: TMetadataInput; readonly result: TResult };
}

const CALLBACKS = ["prefix", "key", "onComplete"] as const;
const POLICY = ["accept", "maxSize", "maxFiles", "metadata", "visibility", "authorize"] as const;

/** JavaScript callers get no type error for an option in the wrong argument, and there it would do nothing. */
function checkPlacement(policy: object, callbacks: object): void {
  const callback = CALLBACKS.find((name) => Object.hasOwn(policy, name));
  if (callback) {
    throw configError(
      `route(): ${callback} belongs in the second argument, which holds prefix, key and onComplete: route({ accept, maxSize, authorize }, { ${callback} }).`,
    );
  }
  const option = POLICY.find((name) => Object.hasOwn(callbacks, name));
  if (option) {
    throw configError(
      `route(): ${option} belongs in the first argument, which holds accept, maxSize, maxFiles, metadata, visibility and authorize. The second takes only prefix, key and onComplete.`,
    );
  }
}

/**
 * An upload route: `route({ accept, maxSize, authorize }, { prefix, onComplete })`. The second argument is optional
 * and typed from what `authorize` returns.
 */
export function route<TAuth extends object, TSchema extends StandardSchema | undefined = undefined, TResult = null>(
  policy: RoutePolicy<TAuth, TSchema>,
  callbacks?: RouteCallbacks<TAuth, SchemaOutput<TSchema>, TResult>,
  // NoInfer: written inside createCloudrop({ routes }), the call would otherwise infer TResult from the expected Route
  // and type a route without onComplete as unknown, not null.
): NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>>> {
  // Plain JavaScript may pass anything; createCloudrop reports a definition without authorize or accept.
  const given: object = policy ?? {};
  checkPlacement(given, callbacks ?? {});
  // The checker cannot relate onComplete's context while TAuth is generic (Jsonified<TAuth> stays deferred); the
  // handler builds exactly the contexts typed above.
  return { definition: { ...given, ...callbacks } as RouteDefinition };
}
