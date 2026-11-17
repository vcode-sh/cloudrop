// Composition root: the settings, the database pool, better-auth, cloudrop and the listener are created here and
// nowhere else. `bun run dev` runs it under `bun run --watch`, which restarts the process; `--hot` would re-evaluate
// modules and leak the pool.
import { r2, s3 } from "cloudrop";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { createDatabase } from "./db/client";
import { readSettings } from "./settings";
import { createUploads } from "./uploads";

const settings = readSettings(process.env);
const db = createDatabase(settings.databaseUrl);
const auth = createAuth(db, settings);
const readSession = (headers: Headers) => auth.api.getSession({ headers });
const uploads = createUploads({
  db,
  // The presets read CLOUDROP_S3_* or CLOUDROP_R2_* on the first request (README.md).
  storage: settings.storage === "s3" ? s3() : r2(),
  readSession,
  webOrigin: settings.webOrigin,
  quotaBytes: settings.quotaBytes,
});
const app = createApp({
  handleAuth: (request) => auth.handler(request),
  readSession,
  uploads,
  db,
  webOrigin: settings.webOrigin,
});

const server = Bun.serve({ port: settings.port, fetch: app.fetch });
console.info(`API listening on ${server.url.origin}, for the web app at ${settings.webOrigin}`);

async function shutdown() {
  await server.stop();
  await db.$client.end();
  process.exit(0);
}
// After the first signal the listeners are gone: a second Ctrl-C kills at once.
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
