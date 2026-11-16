// A hint for the operator when the handler refuses a request for its origin. Behind a proxy that terminates TLS or
// rewrites Host, the app's own pages look cross-origin: the refusal is right (no forwarded header is trusted), but the
// fix, listing the public origin in trustedOrigins, is not obvious from a 403.

import { isExactOrigin } from "./config.ts";
import type { Logger } from "./plugins.ts";

/** Enough for the few origins an operator needs to see, too few for a flood of cross-site requests to matter. */
const MAX_HINTED_ORIGINS = 16;

/** Warns once per refused origin, for at most MAX_HINTED_ORIGINS origins per handler. */
export function originHint(logger: Logger): (request: Request) => void {
  const hinted = new Set<string>();
  return (request) => {
    const origin = request.headers.get("origin");
    // Only an exact origin is echoed: any other value is client text.
    if (!isExactOrigin(origin) || hinted.has(origin) || hinted.size >= MAX_HINTED_ORIGINS) return;
    hinted.add(origin);
    logger.warn(
      `cloudrop: refused a request from ${origin}, but this server sees its own origin as ${new URL(request.url).origin}. If a proxy terminates TLS or rewrites Host, add the app's public origin to trustedOrigins.`,
    );
  };
}
