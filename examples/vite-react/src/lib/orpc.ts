import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "cloudrop-example-hono/types";
import { API_ORIGIN } from "./api";

export const queryClient = new QueryClient();

const link = new RPCLink({
  url: `${API_ORIGIN}/rpc`,
  // The API reads the session from its cookie, which a cross-origin request carries only with credentials.
  fetch: (url, options) => globalThis.fetch(url, { ...options, credentials: "include" }),
});

export const rpc: AppRouterClient = createORPCClient(link);
export const orpc = createTanstackQueryUtils(rpc);
