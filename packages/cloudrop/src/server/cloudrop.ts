import type { InferableCloudrop } from "../protocol/types.ts";
import { createFileApi, type FileApi } from "./api.ts";
import { type CloudropOptions, readConfig } from "./config.ts";
import { createHandler } from "./handler.ts";
import type { Route } from "./route.ts";

type RouteTypeMap<TRoutes extends Record<string, Route>> = {
  [TName in keyof TRoutes & string]: TRoutes[TName] extends Route<infer TMetadata, infer TResult>
    ? { metadata: TMetadata; result: TResult }
    : never;
};

export interface Cloudrop<TRoutes extends Record<string, Route> = Record<string, Route>>
  extends InferableCloudrop<RouteTypeMap<TRoutes>> {
  /** The single adapter surface: mount it at `basePath` in any framework that speaks Request and Response. */
  handler(request: Request): Promise<Response>;
  /** Server-side file operations on the same storage, each returning { data, error }. */
  readonly api: FileApi;
}

/**
 * Checks every option now and throws INVALID_CONFIG for a mistake, so a misconfigured server fails at start-up.
 * Settings from the environment (CLOUDROP_SECRET, a storage preset's variables) are read on the first request instead,
 * so a build needs no secrets; one still missing then makes every request answer 500 and every api call INVALID_CONFIG
 * until it is set. With NODE_ENV=development they are checked now too.
 */
export function createCloudrop<TRoutes extends Record<string, Route>>(
  options: CloudropOptions<TRoutes>,
): Cloudrop<TRoutes> {
  const config = readConfig(options);
  return { handler: createHandler(config), api: createFileApi(config) };
}
