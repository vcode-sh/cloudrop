// The cloudrop/react entry: React hooks over cloudrop/client (spec §6, M4-B1 to M4-B6). `react` is an optional peer
// dependency of this entry only (M4-B7).

import {
  type CloudropClient,
  CloudropError,
  createCloudropClient,
  type InferableCloudrop,
  type Result,
} from "./client.ts";
import { createJobTracker } from "./react/job-tracker.ts";
import type { UploadHooks, UploadHooksOptions, UseUploadOptions } from "./react/types.ts";
import { createUploadStore, type UploadStore } from "./react/upload-store.ts";
import { useResumableWith } from "./react/use-resumable.ts";
import { type HookSource, useUploadWith } from "./react/use-upload.ts";

export type {
  DropProps,
  InputProps,
  UploadHooks,
  UploadHooksOptions,
  UploadItem,
  UseResumableResult,
  UseUploadOptions,
  UseUploadResult,
} from "./react/types.ts";

/**
 * Creates `useUpload` and `useResumable` for one server's routes: `createUploadHooks<typeof cloudrop>()`, with a type
 * import of the server's `cloudrop`. Takes the client's options, or `{ client }` to share a client. The client is
 * created at the first upload, resumable read or close() in the browser, never during a server render; a wrong option
 * makes upload(), resume() and refresh() resolve with its INVALID_CONFIG error.
 */
export function createUploadHooks<TCloudrop extends InferableCloudrop = InferableCloudrop>(
  options: UploadHooksOptions<TCloudrop> = {},
): UploadHooks<TCloudrop> {
  // null counts as no options, as createCloudropClient reads its own (M11-R7).
  const given = options ?? {};
  let created: Result<CloudropClient> | undefined;
  function createClient(): Result<CloudropClient> {
    try {
      const client = "client" in given ? given.client : createCloudropClient<TCloudrop>(given);
      return { data: client as CloudropClient, error: null };
    } catch (error) {
      // createCloudropClient throws only its configuration error (readOptions in client.ts).
      if (error instanceof CloudropError) return { data: null, error };
      throw error;
    }
  }
  const stores = new Map<string, UploadStore<unknown>>();
  const source: HookSource = {
    ...createJobTracker(),
    client() {
      created ??= createClient();
      return created;
    },
    storeOf(route) {
      const store = stores.get(route) ?? createUploadStore();
      stores.set(route, store);
      return store;
    },
  };
  // The factory (M4-B1) runs once, at module level where an app defines its hooks, so the hooks it returns never
  // change.
  // biome-ignore lint/correctness/noComponentHookFactories: route types are inferred only through a factory.
  function useUpload(route: string, options?: UseUploadOptions<unknown>) {
    return useUploadWith(source, route, options);
  }
  // biome-ignore lint/correctness/noComponentHookFactories: as useUpload above.
  function useResumable(route?: string) {
    return useResumableWith(source, route);
  }
  // The client's own stop, every route's uploads included (M8-L7); a client with a wrong option has nothing to stop.
  const close: UploadHooks<TCloudrop>["close"] = (options) => source.client().data?.close(options) ?? Promise.resolve();
  // The hooks run on route names as plain strings: the casts give them the types the server's type carries, as
  // createCloudropClient does.
  return { useUpload, useResumable, close } as UploadHooks<TCloudrop>;
}
