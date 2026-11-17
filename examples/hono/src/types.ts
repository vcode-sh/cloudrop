// What the web app imports from the server: types only, so no server code, secret or database driver reaches the
// browser bundle. `import type` from "cloudrop-example-hono/types".
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./rpc/router";

export type { Uploads } from "./uploads";
export type AppRouterClient = RouterClient<AppRouter>;
