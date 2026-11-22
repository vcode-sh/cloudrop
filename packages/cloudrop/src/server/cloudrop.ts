import type { InferableCloudrop } from "../protocol/types.ts";
import { createFileApi, type FileApi } from "./api.ts";
import { type CloudropOptions, readConfig } from "./config.ts";
import { createHandler } from "./handler.ts";
import type { Route } from "./route.ts";
import type { DeletedOf, ErasedOf, RouteTypeMap } from "./route-types.ts";
import type { CloudropStore } from "./store.ts";
import type { StoreFileApi } from "./store-api.ts";

/**
 * The server `createCloudrop` returns. `TStore` is the type of its `store` option: `api` has the store's calls only
 * when it is surely a store, so a store that is sometimes undefined gives the store-less `api` (M12-T3).
 */
export interface Cloudrop<TRoutes extends Record<string, Route> = Record<string, Route>, TStore = undefined>
  extends InferableCloudrop<RouteTypeMap<TRoutes>> {
  /** The single adapter surface: mount it at `basePath` in any framework that speaks Request and Response. */
  handler(request: Request): Promise<Response>;
  /**
   * Server-side file operations on the same storage, each returning { data, error }; with a store, on its rows too,
   * and `deleteFile` and `eraseOwner` take the `context` the routes' `onDelete` declare (M12-T6).
   */
  readonly api: [TStore] extends [CloudropStore<unknown>]
    ? StoreFileApi<keyof TRoutes & string, DeletedOf<TRoutes>, ErasedOf<TRoutes>>
    : FileApi;
}

/**
 * Checks every option now and throws INVALID_CONFIG for a mistake, so a misconfigured server fails at start-up.
 * Settings from the environment (CLOUDROP_SECRET, a storage preset's variables) are read on the first request instead,
 * so a build needs no secrets; one still missing then makes every request answer 500 and every api call INVALID_CONFIG
 * until it is set. With NODE_ENV=development they are checked now too.
 */
export function createCloudrop<
  TRoutes extends Record<string, Route>,
  TStore extends CloudropStore<unknown> | undefined = undefined,
>(options: CloudropOptions<TRoutes> & ({ store?: undefined } | { store: TStore })): Cloudrop<TRoutes, TStore> {
  const config = readConfig(options);
  // At runtime `api` always has the store's calls, which answer INVALID_CONFIG without a store, for JavaScript callers;
  // the type keeps them only with one.
  const api = createFileApi(config) as Cloudrop<TRoutes, TStore>["api"];
  return { handler: createHandler(config), api };
}
