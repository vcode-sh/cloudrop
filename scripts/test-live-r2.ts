// Runs the storage contract and the upload protocol against a real R2 bucket: `bun run test:live`.
// Credentials come from the file named by CLOUDROP_R2_ENV_FILE (literal NAME=value lines, never run as shell) or, in CI,
// from the environment. They go only into the child's environment. Everything the child prints passes through a
// redactor, so neither the credentials, the account ID, the bucket nor a presigned URL reaches the terminal or a log.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createRedactor, exitCodeFor, loadSettings } from "./live-r2-settings.ts";

const loaded = loadSettings(process.env, (path) => readFileSync(path, "utf8"));
if (loaded.problem !== undefined) {
  console.error(loaded.problem);
  process.exit(2);
}
const { settings } = loaded;

const redactor = createRedactor(Object.values(settings));

const child = spawn(
  "bunx",
  // Extra arguments reach Vitest: `bun run test:live --reporter=verbose`.
  [
    "vitest",
    "run",
    "--project",
    "integration",
    "src/storage/s3-driver.r2.integration.test.ts",
    "src/storage/s3/copy.r2.integration.test.ts",
    "src/server/handler.r2.integration.test.ts",
    "src/plugins/content-checks.r2.integration.test.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("../packages/cloudrop/", import.meta.url)),
    // No colour: an ANSI code in the middle of a value would stop the redactor from matching it. FORCE_COLOR alone,
    // because Node warns when NO_COLOR is set beside it.
    env: { ...process.env, ...settings, FORCE_COLOR: "0" },
    // Its own process group, so one signal reaches bunx, Vitest and every worker, and a force-kill leaves none behind.
    // No stdin: a background group must not read the terminal, and `vitest run` takes no input.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

// The signals that stop this run, wherever they come from (Ctrl-C, `timeout`, a CI cancel, a supervisor). The child is
// in another process group and does not see them from the terminal, so they are forwarded to it, and this script
// keeps relaying (and redacting) until Vitest's teardown has deleted the run prefix. A second signal, or the end of
// the grace period, kills the group.
const GRACE_MS = 30_000;
let stopSignal: "SIGHUP" | "SIGINT" | "SIGTERM" | undefined;
// Each lane file writes under its own prefix; all of them are named if the run is stopped before teardown.
const runPrefixes = new Set<string>();
let forced = false;
function signalChild(signal: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}
function forceStop() {
  if (forced) return;
  forced = true;
  signalChild("SIGKILL");
  console.error(
    `Live R2 lane stopped before its teardown finished. Objects may remain under ${runPrefixes.size > 0 ? [...runPrefixes].join(", ") : "live-test/cloudrop-<random hex>/"} in the bucket: delete those prefixes.`,
  );
  process.exit(128 + (constants.signals[stopSignal ?? "SIGTERM"] ?? 15));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (stopSignal) return forceStop();
    stopSignal = signal;
    signalChild(signal);
    setTimeout(forceStop, GRACE_MS).unref();
  });
}
const relays = [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
] as const;
const relayed = relays.map(async ([from, to]) => {
  for await (const line of createInterface({ input: from, crlfDelay: Number.POSITIVE_INFINITY })) {
    const safe = redactor.redact(line);
    for (const match of safe.matchAll(/live-test\/cloudrop-[0-9a-f]{32}\//g)) runPrefixes.add(match[0]);
    to.write(`${safe}\n`);
  }
});
// A child that never started has no output to wait for, so the error handler exits at once.
child.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    `Could not start the live lane (${error.code ?? "unknown error"}). Is Bun installed and is bunx on your PATH?`,
  );
  process.exit(1);
});
const code = await new Promise<number>((resolve) =>
  child.on("close", (exitCode, signal) => resolve(exitCode ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 1))),
);
await Promise.all(relayed);
console.log(`Live R2 lane: ${redactor.count()} secret or presigned-URL occurrences redacted from the output.`);
if (stopSignal)
  console.error(`Live R2 lane interrupted by ${stopSignal}: this run is not a pass, whatever the child reported.`);
process.exit(exitCodeFor(code, stopSignal));
