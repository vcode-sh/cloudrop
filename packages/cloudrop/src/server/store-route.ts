// The type of a store's own route() (spec M5 §5.1), whose routes see the store's `tx`, and the mark routeFor() leaves
// on them so createCloudrop can check that it is the store the app passed, and one that has a transaction.

import { type Route, type RouteCallbacks, type RouteDefinition, type RoutePolicy, STORE } from "./route.ts";
import type { AuthResult, CompleteData } from "./route-context.ts";
import type { SchemaInput, SchemaOutput, StandardSchema } from "./schema.ts";

/** route(), typed with a store's extra context for `onComplete` and `onDelete`. */
export type RouteFunction<TExtra extends object> = <
  TAuth extends AuthResult,
  TSchema extends StandardSchema | undefined = undefined,
  TResult = null,
>(
  policy: RoutePolicy<TAuth, TSchema>,
  callbacks?: RouteCallbacks<TAuth, SchemaOutput<TSchema>, TResult, TExtra>,
) => NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>>>;

/** The store whose route() made the route, if any. */
export const storeOfRoute = (definition: RouteDefinition): object | undefined => definition[STORE];
