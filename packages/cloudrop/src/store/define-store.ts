import { configError } from "../errors.ts";
import type { CloudropStore } from "../server/store.ts";
import { STORE_PATHS } from "../server/store-paths.ts";
import { storePaths } from "./paths.ts";

/**
 * Makes a hand-written store usable by `createCloudrop`: it attaches the code the server runs with a store, which a
 * server without one never loads. The adapters' stores already have it. Returns the same object, so a class instance
 * keeps its methods and `this`. A copy of the result made with spread (`{ ...store }`) keeps the code too, but only the
 * object's own properties: a class instance's methods live on its prototype, so wrap such a store rather than copy it.
 */
export function defineStore<TStore extends CloudropStore<unknown>>(store: TStore): TStore {
  if (typeof store !== "object" || store === null) {
    throw configError(
      "defineStore takes the store object, with the CloudropStore methods, such as defineStore(myStore).",
    );
  }
  if (!Object.isExtensible(store)) {
    throw configError(
      "defineStore cannot attach the store code to a frozen or sealed store. Pass the store before freezing it, or a copy made with spread ({ ...store }).",
    );
  }
  // Enumerable, so a spread copy of the store keeps it (M12-S1).
  return Object.assign(store, { [STORE_PATHS]: storePaths });
}
