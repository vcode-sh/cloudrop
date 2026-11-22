// The type of a store's own route() (spec M5 §5.1), whose routes see the store's `tx`, and the mark routeFor() leaves
// on them so createCloudrop can check that they come from the store the app passed, and one that has a transaction.

import type { CloudropError } from "../errors.ts";
import type { Refusal } from "./refusal.ts";
import {
  type Authorized,
  type CallbackAuth,
  type Route,
  type RouteCallbacks,
  type RouteDefinition,
  type RoutePolicy,
  STORE,
  STORE_BRAND,
} from "./route.ts";
import type { AuthResult, CompleteData } from "./route-context.ts";
import type { SchemaInput, SchemaOutput, StandardSchema } from "./schema.ts";

/** route(), typed with a store's extra context for `onComplete` and `onDelete`. */
export type RouteFunction<TExtra extends object> = <
  // The refusals too: a function that only refuses infers its refusal here, which Authorized then removes.
  TAuth extends AuthResult | Refusal | CloudropError,
  TSchema extends StandardSchema | undefined = undefined,
  TResult = null,
  TDeleted = unknown,
  TErased = TDeleted,
>(
  policy: RoutePolicy<TAuth, TSchema>,
  callbacks?: RouteCallbacks<CallbackAuth<TAuth>, SchemaOutput<TSchema>, TResult, TExtra, TDeleted, TErased>,
) => NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>, Authorized<TAuth>, TDeleted, TErased>>;

/** The brand of the store whose route() made the route, if any. */
export const storeOfRoute = (definition: RouteDefinition): object | undefined => definition[STORE];

/** The brand a transactional store's route() puts on its routes, if the store has one. */
export const brandOf = (store: object | undefined): object | undefined =>
  (store as { [STORE_BRAND]?: object } | undefined)?.[STORE_BRAND];
