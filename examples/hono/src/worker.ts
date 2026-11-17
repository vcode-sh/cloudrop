// The worker: a separate process that sweeps abandoned uploads on an interval, `bun run worker`. A sweep ends uploads
// whose tickets expired, releases their bytes from each user's quota and removes what they left in the bucket
// (docs/guide/store.md "The sweep"). Two sweeps at once are safe, so a second worker does no harm.
//
// An app with a job queue runs this as a scheduled job instead of a timer: a queue whose schedule fires hourly (off
// the hour, say "41 * * * *" in UTC) and whose handler runs sweepAll below and throws its error, so the queue retries
// the job (docs/guide/hono.md "The sweep, as a scheduled job").
import { r2, type SweepReport, s3 } from "cloudrop";
import { createDatabase } from "./db/client";
import { readSettings } from "./settings";
import { createUploads, type Uploads } from "./uploads";

type SweepTotals = Pick<SweepReport, "expired" | "cleaned" | "failed"> & { reported: number };

/** Sweeps every page, one bounded call at a time; a failed call stops the run, and the next run starts over. */
async function sweepAll(api: Uploads["api"]): Promise<SweepTotals> {
  const totals: SweepTotals = { expired: 0, cleaned: 0, failed: 0, reported: 0 };
  let cursor: string | undefined;
  do {
    const { data, error } = await api.sweep({ cursor });
    if (error) throw error;
    totals.expired += data.expired;
    totals.cleaned += data.cleaned;
    totals.failed += data.failed;
    totals.reported += data.reported.length;
    // Its onComplete may have recorded the file, so the sweep keeps the object: check each one by hand.
    for (const stuck of data.reported) console.warn(`The completion of upload ${stuck.id} never finished; check it.`);
    cursor = data.cursor ?? undefined;
  } while (cursor);
  return totals;
}

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

async function sweepOnce() {
  try {
    const totals = await sweepAll(uploads.api);
    console.info(
      `Sweep done: ${totals.expired} expired, ${totals.cleaned} cleaned up, ${totals.failed} failed, ` +
        `${totals.reported} to check.`,
    );
  } catch (error) {
    console.error(`Sweep stopped: ${error instanceof Error ? error.message : String(error)} The next run retries.`);
  }
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
