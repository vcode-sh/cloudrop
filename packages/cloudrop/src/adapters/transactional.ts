// What every adapter does to a store built with `transaction: true`: give it `route`, for the routes whose onComplete
// receives the store's transaction as `tx`.

import { routeFor } from "../server/route.ts";
import type { CloudropStore, TransactionalStore } from "../server/store.ts";

/** The store with `route`; `transaction` is the store's own, so the caller checks it is there. */
export function withRoute<TTx>(store: CloudropStore<TTx>): TransactionalStore<TTx> {
  // routeFor brands each route with this very object, the one the app passes to createCloudrop.
  return Object.assign(store, { route: routeFor<{ tx: TTx }>(store) }) as TransactionalStore<TTx>;
}
