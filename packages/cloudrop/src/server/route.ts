import { CloudropError, configError } from "../errors.ts";
import { isPlainObject } from "../input.ts";
import type { Jsonified, UploadedFile } from "../protocol/types.ts";
import type { SchemaInput, SchemaOutput, StandardSchema } from "./schema.ts";
import type { Size } from "./size.ts";

export type Awaitable<T> = T | Promise<T>;

// Symbol.for, not Symbol(): two copies of cloudrop in one app must recognise each other's refusals, or one would read
// as a signed-in user.
const DENIED: unique symbol = Symbol.for("cloudrop.unauthorized");
// Symbol.for for the same reason: an adapter may come from another copy of cloudrop than the server.
const STORE: unique symbol = Symbol.for("cloudrop.store");

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

const SIGN_IN_MESSAGE = "Sign in to upload files here.";
const NOT_ALLOWED_MESSAGE =
  "You are not allowed to upload files here. Ask the site owner for access if you think this is wrong.";

/** For a caller who is not signed in. */
export function unauthorized(message: string = SIGN_IN_MESSAGE): Refusal {
  return { [DENIED]: true, code: "UNAUTHORIZED", message };
}

/** For a signed-in caller who may not upload this: a quota, a plan or a role. */
export function forbidden(message: string = NOT_ALLOWED_MESSAGE): Refusal {
  return { [DENIED]: true, code: "FORBIDDEN", message };
}

/** Only a plain object carrying the brand refuses: a Response or an Error is never read as a refusal or as a user. */
export function isRefusal(value: unknown): value is Refusal {
  return isPlainObject(value) && (value as Partial<Refusal>)[DENIED] === true;
}

/** A refusal built by plain JavaScript or another copy of cloudrop may lack a code or a message; it still refuses. */
export function refusalError(refusal: Refusal): CloudropError {
  const forbids = refusal.code === "FORBIDDEN";
  const fallback = forbids ? NOT_ALLOWED_MESSAGE : SIGN_IN_MESSAGE;
  const message = typeof refusal.message === "string" && refusal.message !== "" ? refusal.message : fallback;
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

/** `owner` sees the live authorize result inside `/upload`, once for all of its files. */
export type OwnerContext<TAuth, TMetadata> = Omit<TAuth, ReservedName> & { request: Request; metadata: TMetadata };

/** `prefix` and `key` see the live authorize result; this runs inside `/upload`, once per file. */
export type KeyContext<TAuth, TMetadata> = OwnerContext<TAuth, TMetadata> & {
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

/** `afterComplete` sees what `onComplete` sees, plus the `data` the client was sent. */
export type AfterCompleteContext<TAuth, TMetadata, TResult> = CompleteContext<TAuth, TMetadata> & {
  data: CompleteData<Awaited<TResult>>;
};

/** A store's extra context (an adapter's `tx`) replaces an authorize field of the same name. */
type WithExtra<TContext, TExtra> = [keyof TExtra] extends [never] ? TContext : Omit<TContext, keyof TExtra> & TExtra;

type NoExtra = Record<never, never>;

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
   * With a store and `owner`: one file per owner, such as an avatar. The completion that records a new file deletes the
   * owner's previous ones on this route in the same database write, so two uploads at once leave exactly one; their
   * objects are removed right after, and by the sweep if that fails. Read the kept file with `api.files`, not a pointer
   * set in `onComplete` (store guide). `maxFiles` is then 1; under a quota the owner needs room for both files.
   */
  replace?: boolean;
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
export interface RouteCallbacks<TAuth extends object, TMetadata, TResult, TExtra extends object = NoExtra> {
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
   * can also delete this file through `/abort`, even after `onComplete` has run. A database store closes that gap and
   * runs `onComplete` once per file: inside the store's transaction with `tx` when its route comes from the store's own
   * `route()`, otherwise again only after a crash between claiming the file and recording its completion.
   */
  onComplete?: (context: WithExtra<CompleteContext<TAuth, TMetadata>, TExtra>) => Awaitable<TResult>;
  /**
   * With a store: who the file counts against for `quota` and `api.usage`, 1 to 255 characters, or null for no one.
   * Runs once per `/upload`. Not the authorize result signed into the token; return an id, such as a user or team id.
   */
  owner?: (context: OwnerContext<TAuth, TMetadata>) => Awaitable<string | null>;
  /**
   * With a store: runs after the completion is recorded, at most once per file and best effort. A crash right after the
   * recording skips it, and a throw is logged while the client still gets its answer, which waits for it: keep it short.
   * Call storage and other network services here, not in `onComplete`; for work that must happen, write an outbox row
   * through `tx` in `onComplete`. Write it after `onComplete`: TypeScript infers `data`'s type from `onComplete` only
   * when `onComplete` comes first.
   */
  afterComplete?: (context: AfterCompleteContext<TAuth, TMetadata, TResult>) => Awaitable<void>;
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
  replace?: boolean;
  authorize(context: AuthorizeContext<unknown>): Awaitable<unknown>;
  prefix?(context: KeyContext<object, unknown>): string;
  key?(context: KeyContext<object, unknown>): string;
  owner?(context: OwnerContext<object, unknown>): Awaitable<string | null>;
  onComplete?(context: { request: Request; file: UploadedFile; metadata: unknown }): unknown;
  afterComplete?(context: { request: Request; file: UploadedFile; metadata: unknown; data: unknown }): unknown;
  /** The store whose `route()` made this route, whose `tx` its `onComplete` expects. */
  readonly [STORE]?: object;
}

export interface Route<TMetadataInput = unknown, TResult = unknown> {
  readonly definition: RouteDefinition;
  /** Type-only: never set at runtime. */
  readonly "~types"?: { readonly metadata: TMetadataInput; readonly result: TResult };
}

const CALLBACKS = ["prefix", "key", "owner", "onComplete", "afterComplete"] as const;
const POLICY = ["accept", "maxSize", "maxFiles", "metadata", "visibility", "replace", "authorize"] as const;

/** JavaScript callers get no type error for an option in the wrong argument, and there it would do nothing. */
function checkPlacement(policy: object, callbacks: object): void {
  const callback = CALLBACKS.find((name) => Object.hasOwn(policy, name));
  if (callback) {
    throw configError(
      `route(): ${callback} belongs in the second argument, which holds prefix, key, owner, onComplete and afterComplete: route({ accept, maxSize, authorize }, { ${callback} }).`,
    );
  }
  const option = POLICY.find((name) => Object.hasOwn(callbacks, name));
  if (option) {
    throw configError(
      `route(): ${option} belongs in the first argument, which holds accept, maxSize, maxFiles, metadata, visibility, replace and authorize. The second takes only prefix, key, owner, onComplete and afterComplete.`,
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

/** route(), typed with a store's extra `onComplete` context. */
export type RouteFunction<TExtra extends object> = <
  TAuth extends object,
  TSchema extends StandardSchema | undefined = undefined,
  TResult = null,
>(
  policy: RoutePolicy<TAuth, TSchema>,
  callbacks?: RouteCallbacks<TAuth, SchemaOutput<TSchema>, TResult, TExtra>,
) => NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>>>;

/**
 * For store adapters: a route() whose routes belong to `store`, so their `onComplete` is typed with `TExtra` (the
 * store's `tx`). createCloudrop refuses such a route unless `store` is its store and has a transaction.
 */
export function routeFor<TExtra extends object>(store: object): RouteFunction<TExtra> {
  return (policy, callbacks) => ({
    definition: { ...route(policy, callbacks as RouteCallbacks<object, unknown, unknown>).definition, [STORE]: store },
  });
}

/** The store whose route() made the route, if any. */
export const storeOfRoute = (definition: RouteDefinition): object | undefined => definition[STORE];
