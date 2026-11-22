import { type CloudropError, configError } from "../errors.ts";
import type { UploadedFile } from "../protocol/types.ts";
import type { DeleteContext } from "./delete-context.ts";
import type { Refusal } from "./refusal.ts";
import type {
  AfterCompleteContext,
  AuthorizeContext,
  AuthResult,
  CompleteContext,
  CompleteData,
  KeyContext,
  OwnerContext,
} from "./route-context.ts";
import type { SchemaInput, SchemaOutput, StandardSchema } from "./schema.ts";
import type { Size } from "./size.ts";
import type { RouteFunction } from "./store-route.ts";

export { forbidden, isRefusal, type Refusal, rateLimited, refusalError, unauthorized } from "./refusal.ts";

export type Awaitable<T> = T | Promise<T>;

// Symbol.for, not Symbol(): an adapter may come from another copy of cloudrop than the server, and the server must still
// recognise the routes it marks.
export const STORE: unique symbol = Symbol.for("cloudrop.store");

/** `authorize: allowAnyone` makes a route public. It must be written out: public uploads are never a default. */
export function allowAnyone(): object {
  return {};
}

/**
 * A store's extra context (an adapter's `tx`) beside the hook's own. At runtime it replaces an authorize field of the
 * same name; since M12-A8 the types forbid such a field (`AuthResult`), so a plain intersection is exact. No `Omit`: it
 * would merge `DeleteContext`'s union by `reason` and hide the annotation `onDelete`'s context is inferred from (M12-T6).
 */
type WithExtra<TContext, TExtra> = [keyof TExtra] extends [never] ? TContext : TContext & TExtra;

type NoExtra = Record<never, never>;

/**
 * What `authorize` lets through: the result inferred from it, without the refusals. TypeScript sets a refusal aside
 * only when it is one member of a returned union, so `() => forbidden()` alone infers the refusal itself as the result;
 * here it becomes `never`, a route that authorizes no one, which every typed plugin accepts.
 */
export type Authorized<TAuth> = TAuth extends Refusal | CloudropError ? never : TAuth;

/**
 * The authorize result a route's callbacks see: none of its fields when nobody is authorized, since `never` there
 * would type every field name as `never` and let any typo compile. The callbacks of such a route never run.
 */
export type CallbackAuth<TAuth> = [Authorized<TAuth>] extends [never] ? NoExtra : Authorized<TAuth>;

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
   * browser can read: return ids, never secrets), or refuse with `unauthorized()`, `forbidden()`, `rateLimited(seconds)`
   * or a `CloudropError` of a code /upload may send (server guide). `allowAnyone` makes the route public.
   *
   * It runs only in `/upload`. The token it signs is the authority for the next 24 hours, so a session revoked
   * mid-upload can still finish that upload; check the session again in `onComplete` when that matters.
   */
  authorize: (context: AuthorizeContext<SchemaOutput<TSchema>>) => Awaitable<TAuth | Refusal | CloudropError>;
}

/**
 * route()'s second argument: the callbacks typed from authorize's result. A separate argument because TypeScript
 * infers from callbacks left to right within one object, so one written before authorize would see `object`.
 */
export interface RouteCallbacks<
  TAuth extends object,
  TMetadata,
  TResult,
  TExtra extends object = NoExtra,
  TDeleted = unknown,
  TErased = TDeleted,
> {
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
  /**
   * With a store: runs when `api.deleteFile`, a `replace: true` completion or `api.eraseOwner` deletes one of the
   * route's completed files. Return a `CloudropError` to refuse: the file is kept and the caller answers that error; a
   * throw keeps it too, as a failure (store guide). With a transaction it runs inside it, and writes through `tx`
   * commit once, with the deletion; the hook itself may run more than once, so keep other effects idempotent. Without
   * one, at least once, before the deletion. `context` is what the caller passed to `api.deleteFile` or
   * `api.eraseOwner`; a replacement gets the replacing upload's `request` instead. Annotate the parameter,
   * `DeleteContext<FileDeleter>`, and those calls require a `FileDeleter` (M12-T6).
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: `undefined` would refuse every hook that is an async function.
  onDelete?: (context: WithExtra<DeleteContext<TDeleted, TErased>, TExtra>) => Awaitable<void | CloudropError>;
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
  onDelete?(context: DeleteContext): unknown;
  /** The store whose `route()` made this route, whose `tx` its `onComplete` expects. */
  readonly [STORE]?: object;
}

/**
 * `TAuth` is what `authorize` returns, which plugins are checked against (M12-T5); `TDeleted` and `TErased` are the
 * `context` its `onDelete` declares for `api.deleteFile` and `api.eraseOwner` (M12-T6).
 */
export interface Route<
  TMetadataInput = unknown,
  TResult = unknown,
  TAuth = object,
  TDeleted = unknown,
  TErased = TDeleted,
> {
  readonly definition: RouteDefinition;
  /** Type-only: never set at runtime. */
  readonly "~types"?: {
    readonly metadata: TMetadataInput;
    readonly result: TResult;
    readonly auth: TAuth;
    readonly deleted: TDeleted;
    readonly erased: TErased;
  };
}

const CALLBACKS = ["prefix", "key", "owner", "onComplete", "afterComplete", "onDelete"] as const;
const POLICY = ["accept", "maxSize", "maxFiles", "metadata", "visibility", "replace", "authorize"] as const;

/** JavaScript callers get no type error for an option in the wrong argument, and there it would do nothing. */
function checkPlacement(policy: object, callbacks: object): void {
  const callback = CALLBACKS.find((name) => Object.hasOwn(policy, name));
  if (callback) {
    throw configError(
      `route(): ${callback} belongs in the second argument, which holds prefix, key, owner, onComplete, afterComplete and onDelete: route({ accept, maxSize, authorize }, { ${callback} }).`,
    );
  }
  const option = POLICY.find((name) => Object.hasOwn(callbacks, name));
  if (option) {
    throw configError(
      `route(): ${option} belongs in the first argument, which holds accept, maxSize, maxFiles, metadata, visibility, replace and authorize. The second takes only prefix, key, owner, onComplete, afterComplete and onDelete.`,
    );
  }
}

/**
 * An upload route: `route({ accept, maxSize, authorize }, { prefix, onComplete })`. The second argument is optional
 * and typed from what `authorize` returns.
 */
export function route<
  // The refusals too: a function that only refuses infers its refusal here, which Authorized then removes.
  TAuth extends AuthResult | Refusal | CloudropError,
  TSchema extends StandardSchema | undefined = undefined,
  TResult = null,
  TDeleted = unknown,
  TErased = TDeleted,
>(
  policy: RoutePolicy<TAuth, TSchema>,
  callbacks?: RouteCallbacks<CallbackAuth<TAuth>, SchemaOutput<TSchema>, TResult, NoExtra, TDeleted, TErased>,
  // NoInfer: written inside createCloudrop({ routes }), the call would otherwise infer TResult from the expected Route
  // and type a route without onComplete as unknown, not null.
): NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>, Authorized<TAuth>, TDeleted, TErased>> {
  // Plain JavaScript may pass anything; createCloudrop reports a definition without authorize or accept.
  const given: object = policy ?? {};
  checkPlacement(given, callbacks ?? {});
  // The checker cannot relate onComplete's context while TAuth is generic (Jsonified<TAuth> stays deferred); the
  // handler builds exactly the contexts typed above.
  return { definition: { ...given, ...callbacks } as RouteDefinition };
}

/**
 * For store adapters: a route() whose routes belong to `store`, so their `onComplete` and `onDelete` are typed with
 * `TExtra` (the store's `tx`). createCloudrop refuses such a route unless `store` is its store and has a transaction.
 */
export function routeFor<TExtra extends object>(store: object): RouteFunction<TExtra> {
  return (policy, callbacks) => ({
    definition: { ...route(policy, callbacks as RouteCallbacks<object, unknown, unknown>).definition, [STORE]: store },
  });
}
