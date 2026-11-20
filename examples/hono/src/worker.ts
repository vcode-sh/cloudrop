// The worker: a separate process that sweeps abandoned uploads on an interval, `bun run worker`. A sweep ends uploads
// whose tickets expired, releases their bytes from each user's quota and removes what they left in the bucket
// (docs/guide/store.md "The sweep"). Two sweeps at once are safe, so a second worker does no harm.
//
// An app with a job queue runs this as a scheduled job instead of a timer: a queue whose schedule fires hourly (off
// the hour, say "41 * * * *" in UTC) and whose handler runs the sweep below and throws its error, so the queue retries
// the job when its template allows more than one attempt (docs/guide/hono.md "The sweep, as a scheduled job").
import { r2, s3 } from "cloudrop";
import { createDatabase } from "./db/client";
import { readSettings } from "./settings";
import { createUploads } from "./uploads";

/** A run stops after this long; the next run picks up whatever is left. */
const SWEEP_TIME_LIMIT_MS = 10 * 60_000;

const settings = readSettings(process.env);
const db = createDatabase(settings.databaseUrl);
const uploads = createUploads({
  db,
  storage: settings.storage === "s3" ? s3() : r2(),
  // The worker serves no requests, so it reads no session.
  readSession: async () => null,
  webOrigin: settings.webOrigin,
  quotaBytes: settings.quotaBytes,
});

/** Every page in one call; a failed listing stops the run, and the next run starts over. */
async function sweepOnce() {
  const { data, error } = await uploads.api.sweep({ all: true, signal: AbortSignal.timeout(SWEEP_TIME_LIMIT_MS) });
  if (error) {
    console.error(`Sweep stopped: ${error.message} The next run retries.`);
    return;
  }
  // Its onComplete may have recorded the file, so the sweep keeps the object: check each one by hand.
  for (const stuck of data.reported) console.warn(`The completion of upload ${stuck.id} never finished; check it.`);
  const stopped = data.cursor === null ? "" : " Stopped at the time limit; the next run goes on.";
  console.info(
    `Sweep done: ${data.expired} expired, ${data.cleaned} cleaned up, ${data.failed} failed, ` +
      `${data.reported.length} to check.${stopped}`,
  );
}

await sweepOnce();
const timer = setInterval(sweepOnce, settings.sweepIntervalMs);
console.info(`Worker sweeping every ${settings.sweepIntervalMs / 60_000} minutes`);
const stop = async () => {
  clearInterval(timer);
  await db.$client.end();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
