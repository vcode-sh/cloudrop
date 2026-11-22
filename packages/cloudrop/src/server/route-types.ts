// The types read off a server's routes: what the client infers, what plugins are checked against (M12-T5) and the
// deletion context `api` asks for (M12-T6).

import type { Route } from "./route.ts";

/** Each route's metadata input and result, for the client. */
export type RouteTypeMap<TRoutes extends Record<string, Route>> = {
  [TName in keyof TRoutes & string]: TRoutes[TName] extends Route<infer TMetadata, infer TResult>
    ? { metadata: TMetadata; result: TResult }
    : never;
};

/** The union of every route's authorize result: a plugin's `auth` is one of them. */
export type AuthOf<TRoutes extends Record<string, Route>> = {
  [TName in keyof TRoutes]: TRoutes[TName] extends Route<unknown, unknown, infer TAuth> ? TAuth : never;
}[keyof TRoutes];

/**
 * The intersection of what each route's `onDelete` declares for one reason: a call that may delete a file of any
 * route must pass a context every one of them accepts. Routes without an annotation add `unknown`, which changes
 * nothing. Read through a parameter position, so TypeScript infers the intersection.
 */
type ContextOf<TRoutes extends Record<string, Route>, TReason extends "deleted" | "erased"> = {
  [TName in keyof TRoutes]: (
    context: NonNullable<TRoutes[TName]["~types"]> extends { readonly [K in TReason]: infer TContext }
      ? TContext
      : unknown,
  ) => void;
}[keyof TRoutes] extends (context: infer TContext) => void
  ? TContext
  : unknown;

/** What `api.deleteFile` passes to every route's `onDelete` as `context`. */
export type DeletedOf<TRoutes extends Record<string, Route>> = ContextOf<TRoutes, "deleted">;

/** What `api.eraseOwner` passes to every route's `onDelete` as `context`. */
export type ErasedOf<TRoutes extends Record<string, Route>> = ContextOf<TRoutes, "erased">;
