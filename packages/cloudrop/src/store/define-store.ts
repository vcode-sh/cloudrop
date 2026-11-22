import type { CloudropStore } from "../server/store.ts";
import { STORE_PATHS } from "../server/store-paths.ts";
import { storePaths } from "./paths.ts";

/**
 * Makes a hand-written store usable by `createCloudrop`: it attaches the code the server runs with a store, which a
 * server without one never loads. The adapters' stores already have it. Returns the same object, so its methods keep
 * their `this`; a copy made with spread (`{ ...store }`) keeps the code too.
 */
export function defineStore<TStore extends CloudropStore<unknown>>(store: TStore): TStore {
  // Enumerable, so a spread copy of the store keeps it (M12-S1).
  return Object.assign(store, { [STORE_PATHS]: storePaths });
}
