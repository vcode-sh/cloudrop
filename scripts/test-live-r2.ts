// Runs the storage contract against a real R2 bucket: `bun run test:live`.
// Credentials come from the file named by CLOUDROP_R2_ENV_FILE (literal NAME=value lines, never run as shell) or, in CI,
// from the environment. They go only into the child's environment. Everything the child prints passes through a
// redactor, so neither the credentials, the account ID, the bucket nor a presigned URL reaches the terminal or a log.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createRedactor, explainMissing, type FileState, parseSettingsFile, VARIABLES } from "./live-r2-settings.ts";

const settings: Record<string, string> = {};
for (const name of VARIABLES.values()) {
  const value = process.env[name];
  if (value) settings[name] = value;
}
const file = process.env.CLOUDROP_R2_ENV_FILE;
let fileState: FileState = "none";
if (file) {
  try {
    Object.assign(settings, parseSettingsFile(readFileSync(file, "utf8")));
    fileState = "read";
  } catch (error) {
    // Only the error code is reported: a message could quote file content.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `Cannot read ${file} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Check its permissions.`,
      );
      process.exit(2);
    }
    fileState = "not-found";
  }
}
const missing = [...VARIABLES.values()].filter((name) => !settings[name]);
if (missing.length > 0) {
  console.error(explainMissing(missing, file, fileState));
  process.exit(2);
}

const redactor = createRedactor(Object.values(settings));

// Ctrl-C reaches the child from the terminal as well. The parent must outlive it, relaying output until the child
// closes, so Vitest's teardown (which deletes the run prefix) can finish and its output stays redacted.
process.on("SIGINT", () => {});

const child = spawn(
  "bunx",
  // Extra arguments reach Vitest: `bun run test:live --reporter=verbose`.
  [
    "vitest",
    "run",
    "--project",
    "integration",
    "src/storage/s3-driver.r2.integration.test.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: fileURLToPath(new URL("../packages/cloudrop/", import.meta.url)),
    // No colour: an ANSI code in the middle of a value would stop the redactor from matching it.
    env: { ...process.env, ...settings, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["inherit", "pipe", "pipe"],
  },
);
const relays = [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
] as const;
const relayed = relays.map(async ([from, to]) => {
  for await (const line of createInterface({ input: from, crlfDelay: Number.POSITIVE_INFINITY })) {
    to.write(`${redactor.redact(line)}\n`);
  }
});
// A child that never started has no output to wait for, so the error handler exits at once.
child.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    `Could not start the live lane (${error.code ?? "unknown error"}). Is Bun installed and is bunx on your PATH?`,
  );
  process.exit(1);
});
const code = await new Promise<number>((resolve) => child.on("close", (exitCode) => resolve(exitCode ?? 1)));
await Promise.all(relayed);
console.log(`Live R2 lane: ${redactor.count()} secret or presigned-URL occurrences redacted from the output.`);
process.exit(code);
