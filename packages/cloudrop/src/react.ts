// The cloudrop/react entry: React hooks over cloudrop/client (spec §6, M4-B1 to M4-B6). `react` is an optional peer
// dependency of this entry only (M4-B7).

import { type CloudropClient, createCloudropClient, type InferableCloudrop } from "./client.ts";
import type { UploadHooks, UploadHooksOptions, UseUploadOptions } from "./react/types.ts";
import { useResumableWith } from "./react/use-resumable.ts";
import { type HookSource, useUploadWith } from "./react/use-upload.ts";

export type {
  DropProps,
  InputProps,
  UploadFile,
  UploadHooks,
  UploadHooksOptions,
  UseResumableResult,
  UseUploadOptions,
  UseUploadResult,
} from "./react/types.ts";

/**
 * Creates `useUpload` and `useResumable` for one server's routes: `createUploadHooks<typeof cloudrop>()`, with a type
 * import of the server's `cloudrop`. Takes the client's options, or `{ client }` to share a client. The client is
 * created at the first upload or resumable read in the browser, never during a server render, so a wrong option throws
 * its configuration error there.
 */
export function createUploadHooks<TCloudrop extends InferableCloudrop = InferableCloudrop>(
  options: UploadHooksOptions<TCloudrop> = {},
): UploadHooks<TCloudrop> {
  const create = "client" in options ? () => options.client : () => createCloudropClient<TCloudrop>(options);
  let created: CloudropClient<TCloudrop> | undefined;
  const settledListeners = new Set<() => void>();
  const source: HookSource = {
    client() {
      created ??= create();
      return created as CloudropClient;
    },
    started: (job) => {
      void job.done.then(() => {
        for (const listener of settledListeners) listener();
      });
    },
    onSettled(listener) {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
  };
  // The factory (M4-B1) runs once, at module level where an app defines its hooks, so the hooks it returns never change.
  // biome-ignore lint/correctness/noComponentHookFactories: route types are inferred only through a factory.
  function useUpload(route: string, options?: UseUploadOptions<unknown>) {
    return useUploadWith(source, route, options);
  }
  // biome-ignore lint/correctness/noComponentHookFactories: as useUpload above.
  function useResumable(route?: string) {
    return useResumableWith(source, route);
  }
  // The hooks run on route names as plain strings: the casts give them the types the server's type carries, as
  // createCloudropClient does.
  return { useUpload, useResumable } as UploadHooks<TCloudrop>;
}
