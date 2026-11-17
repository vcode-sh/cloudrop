// better-auth on the app's Drizzle database: email and password, for the demo (no email is sent, so nothing is
// verified). Cookie model: host-only cookies on the API's host, `SameSite=Lax`. The web app calls the API
// from another origin of the same site (localhost:5173 to localhost:5181), so the browser sends them with
// `credentials: "include"`; never move the two to different sites (docs/guide/deployment.md).
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import type { Database } from "./db/client";
import * as schema from "./db/schema";
import type { Settings } from "./settings";

export function createAuth(db: Database, settings: Pick<Settings, "apiOrigin" | "webOrigin" | "authSecret">) {
  return betterAuth({
    // Fixed, so nothing derives URLs from Host or X-Forwarded-* headers.
    baseURL: settings.apiOrigin,
    secret: settings.authSecret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    trustedOrigins: [settings.webOrigin],
    advanced: {
      // Keeps these cookies apart from other localhost projects' better-auth cookies.
      cookiePrefix: "cloudrop-example",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    telemetry: { enabled: false },
  });
}
