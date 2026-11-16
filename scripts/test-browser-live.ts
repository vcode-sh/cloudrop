// The browser lane on a real R2 bucket: `bun run test:browser:live`. Playwright builds and starts the Next.js example
// on R2 and uploads from headless Chromium; afterwards this script deletes the run's prefix and prints how many objects
// it held. Settings are loaded as scripts/test-live-r2.ts loads them and go only into the child's environment;
// everything the child prints passes through the redactor.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createCloudrop, r2, route } from "../packages/cloudrop/src/index.ts";
import { createRedactor, exitCodeFor, loadSettings } from "./live-r2-settings.ts";

const loaded = loadSettings(process.env, (path) => readFileSync(path, "utf8"));
if (loaded.problem !== undefined) {
  console.error(loaded.problem);
  process.exit(2);
}
const { settings } = loaded;

// The bucket's CORS rule names http://localhost:5173, so the example can serve nowhere else.
const portFree = await new Promise<boolean>((resolve) => {
  const probe = createServer()
    .once("error", () => resolve(false))
    .listen(5173, () => probe.close(() => resolve(true)));
});
if (!portFree) {
  console.error("Port 5173 is in use. Stop what listens there; the example must serve on it.");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
// The example imports the built package, so a stale dist would test old code. The build needs no settings.
if (spawnSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" }).status !== 0) {
  console.error("Building cloudrop failed; fix the build before running the browser lane.");
  process.exit(1);
}

const prefix = `live-test/cloudrop-${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`;
// A fresh secret per run: no token from this run is valid anywhere else.
const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const redactor = createRedactor([...Object.values(settings), secret]);

const child = spawn("bunx", ["playwright", "test", ...process.argv.slice(2)], {
  cwd: `${root}examples/next`,
  env: {
    ...process.env,
    ...settings,
    CLOUDROP_SECRET: secret,
    CLOUDROP_EXAMPLE_PREFIX: prefix,
    // Exported and empty: it wins over a RustFS .env.local, so lib/cloudrop.ts uses r2().
    CLOUDROP_S3_ENDPOINT: "",
    // No colour: an ANSI code in the middle of a value would stop the redactor from matching it. FORCE_COLOR alone,
    // because Node warns when NO_COLOR is set beside it.
    FORCE_COLOR: "0",
  },
  // Its own process group, so one signal reaches bunx and Playwright. Playwright starts the web server and Chromium in
  // groups of their own and stops them itself when it is signalled, but not when it is killed.
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});

// A signal is forwarded to the child's group; a second one, or the end of the grace period, kills the group. Either
// way this script waits for the child to end and then deletes the prefix.
const GRACE_MS = 30_000;
let stopSignal: "SIGHUP" | "SIGINT" | "SIGTERM" | undefined;
let killed = false;
function signalChild(signal: NodeJS.Signals) {
  killed ||= signal === "SIGKILL";
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (stopSignal) return signalChild("SIGKILL");
    stopSignal = signal;
    signalChild(signal);
    setTimeout(() => signalChild("SIGKILL"), GRACE_MS).unref();
  });
}
const relayed = (
  [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const
).map(async ([from, to]) => {
  for await (const line of createInterface({ input: from, crlfDelay: Number.POSITIVE_INFINITY })) {
    to.write(`${redactor.redact(line)}\n`);
  }
});
child.on("error", (error: NodeJS.ErrnoException) => {
  // Nothing was written yet, so there is nothing to delete.
  console.error(`Could not start Playwright (${error.code ?? "unknown error"}). Is bunx on your PATH?`);
  process.exit(1);
});
const code = await new Promise<number>((resolve) =>
  child.on("close", (exitCode, signal) => resolve(exitCode ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 1))),
);
await Promise.all(relayed);

const cloudrop = createCloudrop({
  storage: r2({
    accountId: settings.CLOUDROP_R2_ACCOUNT_ID,
    bucket: settings.CLOUDROP_R2_BUCKET ?? "",
    accessKeyId: settings.CLOUDROP_R2_ACCESS_KEY_ID,
    secretAccessKey: settings.CLOUDROP_R2_SECRET_ACCESS_KEY,
  }),
  secret,
  // createCloudrop needs a route; this one only lets the script reach api.deletePrefix.
  routes: { cleanup: route({ accept: ["text/plain"], maxSize: "1KB", authorize: () => ({}) }) },
});
const removed = await cloudrop.api.deletePrefix(`${prefix}/`);
if (removed.error) {
  console.error(
    redactor.redact(`Could not delete ${prefix}/ (${removed.error.message}). Delete that prefix in the bucket.`),
  );
} else {
  console.log(`Deleted ${removed.data.deleted} objects under this run's prefix; the prefix is now empty.`);
}
console.log(`Browser lane on R2: ${redactor.count()} secret or presigned-URL occurrences redacted from the output.`);
if (stopSignal) {
  console.error(
    `Interrupted by ${stopSignal}: this run is not a pass, whatever Playwright reported. An upload cut short can leave an unfinished multipart upload under the prefix, which deletePrefix does not see; the bucket's lifecycle rule aborts it.`,
  );
}
if (killed) {
  console.error(
    "Playwright was killed before it could stop the example server, which may still listen on port 5173: find it with `lsof -i :5173` and stop it.",
  );
}
process.exit(exitCodeFor(code, stopSignal) || (removed.error ? 1 : 0));
