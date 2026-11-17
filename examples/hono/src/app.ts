// The HTTP app, built without side effects from its dependencies (src/index.ts makes them). Middleware order is the
// request pipeline: CORS for the app's own routes, then better-auth, cloudrop and oRPC. Only /rpc reads the session
// here; cloudrop reads it in each route's `authorize`.
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Database } from "./db/client";
import { router } from "./rpc/router";
import type { ReadSession, Uploads } from "./uploads";

/** Where cloudrop's handler is mounted: its default `basePath`. */
const UPLOADS_PATH = "/api/cloudrop";
const PREFLIGHT_CACHE_SECONDS = 86_400;

export interface AppDeps {
  /** better-auth's HTTP handler for /api/auth/*. */
  handleAuth: (request: Request) => Promise<Response>;
  /** The session behind the request's cookie; called once per /rpc request. */
  readSession: ReadSession;
  uploads: Pick<Uploads, "handler" | "api">;
  db: Database;
  /** The web app's origin, the only one allowed to call with credentials. */
  webOrigin: string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  // oRPC reads multipart form bodies, which a page on another origin of the same site can post without a preflight,
  // and the browser sends the SameSite=Lax session cookie with them. The plugin refuses every call without the
  // `x-csrf-token: orpc` header that only the app's own client sends (SimpleCsrfProtectionLinkPlugin): a custom header
  // needs a preflight, which CORS answers for the web origin alone.
  const rpc = new RPCHandler(router, { plugins: [new SimpleCsrfProtectionHandlerPlugin()] });

  const browserCors = cors({
    origin: deps.webOrigin,
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-CSRF-Token"],
    maxAge: PREFLIGHT_CACHE_SECONDS,
  });
  // Not for cloudrop's path. hono/cors answers every OPTIONS itself and never calls the route, so cloudrop's own
  // preflight, which checks the origin against its `trustedOrigins` and allows the headers the page asks for (an
  // `Authorization` bearer token, say), would never run: uploads would work only while this list happens to cover
  // them. cloudrop sets the CORS headers on its other answers too.
  app.use((c, next) => (c.req.path.startsWith(`${UPLOADS_PATH}/`) ? next() : browserCors(c, next)));

  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.handleAuth(c.req.raw));
  // The methods cloudrop's handler serves: POST for /upload, /sign, /complete and /abort, OPTIONS for their preflight.
  app.on(["POST", "OPTIONS"], `${UPLOADS_PATH}/*`, (c) => deps.uploads.handler(c.req.raw));

  app.use("/rpc/*", async (c, next) => {
    const session = await deps.readSession(c.req.raw.headers);
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { userId: session?.user.id ?? null, db: deps.db, files: deps.uploads.api },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  app.get("/health", (c) => c.text("OK"));
  return app;
}
