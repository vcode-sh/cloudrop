import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "cloudrop-example-hono/types";
import { API_ORIGIN } from "./api";

const queryClients = new Map<string, QueryClient>();

/** One query cache per user, so whoever signs in next never sees the last user's cached files or avatar. */
export function queryClientFor(userId: string): QueryClient {
  const known = queryClients.get(userId) ?? new QueryClient();
  queryClients.set(userId, known);
  return known;
}

const link = new RPCLink({
  url: `${API_ORIGIN}/rpc`,
  // The API reads the session from its cookie, which a cross-origin request carries only with credentials.
  fetch: (url, options) => globalThis.fetch(url, { ...options, credentials: "include" }),
  // Sends the header the API's SimpleCsrfProtectionHandlerPlugin requires; a form posted from another page cannot.
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
});

export const rpc: AppRouterClient = createORPCClient(link);
export const orpc = createTanstackQueryUtils(rpc);
