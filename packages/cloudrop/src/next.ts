// cloudrop/next: `export const { GET, POST, OPTIONS } = toNextHandler(cloudrop)` in app/api/cloudrop/[...all]/route.ts.

import { configError } from "./errors.ts";
import type { RequestHandler } from "./protocol/types.ts";

export type { RequestHandler } from "./protocol/types.ts";

export interface NextRouteHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
  /** CORS preflights from trustedOrigins. */
  OPTIONS(request: Request): Promise<Response>;
}

export function toNextHandler(cloudrop: RequestHandler): NextRouteHandlers {
  // Plain JavaScript can pass anything here.
  if (typeof (cloudrop as Partial<RequestHandler> | null)?.handler !== "function") {
    throw configError(
      "toNextHandler needs the cloudrop server, an object with a handler function: pass what createCloudrop returned.",
    );
  }
  // Called on cloudrop, not detached from it, so a handler that reads `this` keeps working.
  const handle = (request: Request) => cloudrop.handler(request);
  return { GET: handle, POST: handle, OPTIONS: handle };
}
