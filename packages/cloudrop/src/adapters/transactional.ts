// What every adapter does to a store built with `transaction: true`: give it `route`, for the routes whose onComplete
// receives the store's transaction as `tx`.

import { routeFor, STORE_BRAND } from "../server/route.ts";
import type { CloudropStore, TransactionalStore } from "../server/store.ts";

/** The store with `route`; `transaction` is the store's own, so the caller checks it is there. */
export function withRoute<TTx>(store: CloudropStore<TTx>): TransactionalStore<TTx> {
  // A brand of its own rather than the store object: a spread copy of the store keeps it, so createCloudrop accepts
  // the copy with the routes of its route() (M12-R1).
  const brand = {};
  return Object.assign(store, { [STORE_BRAND]: brand, route: routeFor<{ tx: TTx }>(brand) }) as TransactionalStore<TTx>;
}
