// createCloudrop's store options (M5 spec §5.1), checked once at construction like every other option: a mistake
// throws INVALID_CONFIG naming the option and the fix.

import { configError } from "../errors.ts";
import type { RouteConfig } from "./config.ts";
import type { Awaitable } from "./route.ts";
import { isFunction } from "./route-config.ts";
import type { CloudropStore } from "./store.ts";
import { storeOfRoute } from "./store-route.ts";

/** An owner's limit in bytes, or null for no limit. */
export type Quota = (owner: string) => Awaitable<number | null>;

export interface StoreOptions {
  /**
   * A database store, such as `sqlStore(...)` from `cloudrop/adapters/sql`. With one, `/upload` writes a row per file
   * before anything is signed, `onComplete` runs once per file, `/abort` never deletes a completed file, and `api`
   * gains `file`, `files`, `allFiles`, `usage`, `revokeUploads`, `deleteFile`, `eraseOwner`, `reconcile` and `sweep`.
   */
  store?: CloudropStore<unknown>;
  /**
   * With a store: each owner's limit in bytes (null: no limit), asked once per `/upload` before its files are reserved.
   * A file over the limit is refused with QUOTA_EXCEEDED; a throw refuses the whole upload, retryably.
   */
  quota?: Quota;
  /**
   * With a store: how long a `/complete` may hold a file while `onComplete` runs before another request may take it
   * over. Make it longer than your slowest `onComplete`. Default 300000 (5 minutes), at most 2592000000 (30 days).
   */
  completionLeaseMs?: number;
}

export interface StoreConfig {
  store: CloudropStore<unknown> | undefined;
  quota: Quota | undefined;
  completionLeaseMs: number;
}

const DEFAULT_LEASE_MS = 300_000;
/**
 * 30 days, far beyond any completion. The claim and the sweep subtract the lease from the time, and the result must
 * stay a date every database stores.
 */
const MAX_LEASE_MS = 2_592_000_000;
const STORE_METHODS = [
  "reserve",
  "attach",
  "get",
  "claim",
  "release",
  "complete",
  "end",
  "revoke",
  "stale",
  "list",
  "cleaned",
  "usage",
  "reconcile",
  "owners",
] as const;

function readStoreObject(given: unknown): CloudropStore<unknown> | undefined {
  if (given === undefined) return undefined;
  const store = (typeof given === "object" && given !== null ? given : {}) as Record<string, unknown>;
  const missing = STORE_METHODS.find((method) => !isFunction(store[method]));
  if (missing) {
    throw configError(
      `store must be a CloudropStore, such as sqlStore(...) from cloudrop/adapters/sql. Its ${missing} method is missing.`,
    );
  }
  if (store.transaction !== undefined && !isFunction(store.transaction)) {
    throw configError("store.transaction must be a function, or left out for a store without transactions.");
  }
  return given as CloudropStore<unknown>;
}

/** A replacing route deletes by owner in the store's own write, so it needs both. */
function checkReplace(name: string, definition: RouteConfig["definition"], store: CloudropStore<unknown> | undefined) {
  if (!store) {
    throw configError(
      `Route "${name}": replace needs a database store, which deletes the previous file when the next one completes. Pass store to createCloudrop, or remove replace.`,
    );
  }
  if (!definition.owner) {
    throw configError(
      `Route "${name}": replace keeps one file per owner, so it needs owner. Add owner to the route, or remove replace.`,
    );
  }
}

/** Route callbacks that only a store can serve, and routes made by a store's own route(). */
function checkRoutes(routes: readonly RouteConfig[], store: CloudropStore<unknown> | undefined): void {
  for (const { name, definition, replace } of routes) {
    if (replace) checkReplace(name, definition, store);
    const needsStore = (["owner", "afterComplete", "onDelete"] as const).find((callback) => definition[callback]);
    if (needsStore && !store) {
      throw configError(
        `Route "${name}": ${needsStore} needs a database store. Pass store to createCloudrop, or remove ${needsStore}.`,
      );
    }
    const routeStore = storeOfRoute(definition);
    if (routeStore === undefined) continue;
    if (routeStore !== store) {
      throw configError(
        `Route "${name}" was made by another store's route(), so its onComplete expects that store's tx. Pass that store to createCloudrop, or build the route with route().`,
      );
    }
    if (!store?.transaction) {
      throw configError(
        `Route "${name}" expects a tx in onComplete, but the store has no transaction. Build the store with transaction: true, or build the route with route().`,
      );
    }
  }
}

export function readStoreConfig(options: StoreOptions, routes: readonly RouteConfig[]): StoreConfig {
  const store = readStoreObject(options.store);
  const { quota, completionLeaseMs } = options;
  if (!store && quota !== undefined) {
    throw configError("quota needs a database store to count usage. Pass store to createCloudrop, or remove quota.");
  }
  if (!store && completionLeaseMs !== undefined) {
    throw configError(
      "completionLeaseMs needs a database store. Pass store to createCloudrop, or remove completionLeaseMs.",
    );
  }
  if (quota !== undefined && !isFunction(quota)) {
    throw configError("quota must be a function from an owner to their limit in bytes, or null for no limit.");
  }
  const leaseMs = completionLeaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > MAX_LEASE_MS) {
    throw configError(
      `completionLeaseMs must be a whole number of milliseconds from 1000 to ${MAX_LEASE_MS} (30 days), such as 300000.`,
    );
  }
  checkRoutes(routes, store);
  return { store, quota, completionLeaseMs: leaseMs };
}

/** The routes whose uploads a quota cannot count, because they name no owner. */
export function unownedRoutes(config: StoreConfig & { routes: ReadonlyMap<string, RouteConfig> }): string[] {
  if (!config.quota) return [];
  return [...config.routes.values()].filter((route) => !route.definition.owner).map((route) => route.name);
}
