// The store's code, as the server reaches it (M12-S1): the store object carries it under STORE_PATHS, so a server
// without a store never imports it. Only the types of the modules are named here; src/store/paths.ts holds the modules
// themselves, and only stores import that file.

/** A global symbol, so a store built by another copy of cloudrop is recognised, and then refused by its version. */
export const STORE_PATHS: unique symbol = Symbol.for("cloudrop.store");

/**
 * The store paths the core endpoints and `api` call, one member per module. The modules the api reaches through
 * `store-api` (erasure, the sweep, listings, deletion, leftovers) need no member: they are imported behind it.
 */
export interface StorePaths {
  /** The shape of this interface. Code from a copy of cloudrop with another shape is refused. */
  readonly version: 1;
  readonly upload: typeof import("./store-upload.ts");
  readonly complete: typeof import("./store-complete.ts");
  readonly calls: typeof import("./store-calls.ts");
  readonly api: typeof import("./store-api.ts");
}
