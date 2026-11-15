import type { InferableCloudrop } from "../protocol/types.ts";
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
}

/** Checks every option now and throws INVALID_CONFIG for a mistake, so a misconfigured server fails at start-up. */
export function createCloudrop<TRoutes extends Record<string, Route>>(
  options: CloudropOptions<TRoutes>,
): Cloudrop<TRoutes> {
  const config = readConfig(options);
  return { handler: createHandler(config) };
}
