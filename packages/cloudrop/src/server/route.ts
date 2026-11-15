import type { Jsonified, UploadedFile } from "../protocol/types.ts";
import { isPlainObject } from "../storage/validate.ts";
import type { SchemaInput, SchemaOutput, StandardSchema } from "./schema.ts";
import type { Size } from "./size.ts";

export type Awaitable<T> = T | Promise<T>;

// Symbol.for, not Symbol(): two copies of cloudrop in one app must recognise each other's refusals, or one would read
// as a signed-in user.
const DENIED: unique symbol = Symbol.for("cloudrop.unauthorized");

/** Returned by `authorize` to refuse an upload: the client gets UNAUTHORIZED with `message`. */
export interface Unauthorized {
  readonly [DENIED]: true;
  readonly message: string;
}

export function unauthorized(message = "Sign in to upload files here."): Unauthorized {
  return { [DENIED]: true, message };
}

/** Only a plain object carrying the brand refuses: a Response or an Error is never read as a refusal or as a user. */
export function isUnauthorized(value: unknown): value is Unauthorized {
  return isPlainObject(value) && (value as Partial<Unauthorized>)[DENIED] === true;
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
  metadata: undefined extends TMetadata ? Jsonified<Exclude<TMetadata, undefined>> | undefined : Jsonified<TMetadata>;
};

/** What `/complete` sends as `data`: the JSON form of the result, and null where `onComplete` gave undefined or nothing. */
type CompleteData<TResult> = Jsonified<TResult> | (undefined extends TResult ? null : never);

export interface RouteOptions<TAuth extends object, TSchema extends StandardSchema | undefined, TResult> {
  /** MIME types such as "image/png", "image/*" or "*\/*". The file name's extension must agree with the type. */
  accept: string | readonly string[];
  /** Bytes, or "5MB" style (binary units). */
  maxSize: Size;
  /** Files per `/upload` call, 1 to 100. Default 10. */
  maxFiles?: number;
  /** Any Standard Schema (zod, valibot, arktype). Its output, as JSON, must fit in 2 KiB. */
  metadata?: TSchema;
  /**
   * Required. Return a plain object with the facts later steps need (they are signed into the upload token, which the
   * browser can read: return ids, never secrets), or `unauthorized()`. `allowAnyone` makes the route public.
   *
   * Write it before `prefix`, `key` and `onComplete`: TypeScript infers their context from it in the order the
   * options are written.
   *
   * It runs only in `/upload`. The token it signs is the authority for the next 24 hours, so a session revoked
   * mid-upload can still finish that upload; check the session again in `onComplete` when that matters.
   */
  authorize: (context: AuthorizeContext<SchemaOutput<TSchema>>) => Awaitable<TAuth | Unauthorized>;
  /** Folder for generated keys `<prefix>/<ulid><ext>`. Sanitized like every key. */
  prefix?: (context: KeyContext<TAuth, SchemaOutput<TSchema>>) => string;
  /** The whole key instead of `<prefix>/<ulid><ext>`; it must be unique. Sanitized like every key. */
  key?: (context: KeyContext<TAuth, SchemaOutput<TSchema>>) => string;
  /** "public" needs the storage's `publicUrl`. Default: "public" when the storage has one, otherwise "private". */
  visibility?: "public" | "private";
  /**
   * Runs inside `/complete`, at least once per file; its JSON result reaches the client as `data`.
   *
   * `authorize` is not called again here: `request` carries the caller's cookies and headers, so re-check a session
   * that may have been revoked since `/upload`. Until the token expires (24 hours after `/upload`), whoever holds it
   * can also delete this file through `/abort`, even after `onComplete` has run. The 1.1 database adapters close that
   * gap for completed files.
   */
  onComplete?: (context: CompleteContext<TAuth, SchemaOutput<TSchema>>) => Awaitable<TResult>;
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

export function route<TAuth extends object, TSchema extends StandardSchema | undefined = undefined, TResult = null>(
  options: RouteOptions<TAuth, TSchema, TResult>,
): Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>> {
  // The checker cannot relate onComplete's context while TAuth is generic (Jsonified<TAuth> stays deferred); the
  // handler builds exactly the contexts typed above.
  return { definition: options as RouteDefinition };
}
