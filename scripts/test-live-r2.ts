// Runs the storage contract against a real R2 bucket: `bun run test:live`.
// Credentials come from the file named by CLOUDROP_R2_ENV_FILE (literal NAME=value lines, never run as shell) or, in CI,
// from the environment. They go only into the child's environment. Everything the child prints passes through a
// redactor, so neither the credentials, the account ID, the bucket nor a presigned URL reaches the terminal or a log.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The file may use cloudrop's names or BB_R2_* ones; both map to the variables the lane and r2() read.
const VARIABLES = new Map([
  ["ACCOUNT_ID", "CLOUDROP_R2_ACCOUNT_ID"],
  ["BUCKET", "CLOUDROP_R2_BUCKET"],
  ["ACCESS_KEY_ID", "CLOUDROP_R2_ACCESS_KEY_ID"],
  ["SECRET_ACCESS_KEY", "CLOUDROP_R2_SECRET_ACCESS_KEY"],
]);

const settings: Record<string, string> = {};
for (const name of VARIABLES.values()) {
  const value = process.env[name];
  if (value) settings[name] = value;
}
const file = process.env.CLOUDROP_R2_ENV_FILE;
if (file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^(?:CLOUDROP|BB)_R2_([A-Z_]+)=(.*)$/.exec(line.trim());
    const name = match && VARIABLES.get(match[1] ?? "");
    if (match && name) settings[name] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
}
const missing = [...VARIABLES.values()].filter((name) => !settings[name]);
if (missing.length > 0) {
  console.error(
    `Missing R2 settings: ${missing.join(", ")}. Set CLOUDROP_R2_ENV_FILE to a file that defines them (CLOUDROP_R2_* or BB_R2_* names), or export them.`,
  );
  process.exit(2);
}

// Longest first, so a value that contains another is replaced whole.
const secrets = Object.values(settings).toSorted((a, b) => b.length - a.length);
const PRESIGNED_URL = /https?:\/\/\S*X-Amz-\S*/g;
let redactions = 0;
function redact(line: string): string {
  let out = line.replace(PRESIGNED_URL, () => {
    redactions++;
    return "<presigned URL>";
  });
  for (const secret of secrets) {
    const parts = out.split(secret);
    redactions += parts.length - 1;
    out = parts.join("<redacted>");
  }
  return out;
}

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
    env: { ...process.env, ...settings },
    stdio: ["inherit", "pipe", "pipe"],
  },
);
const relays = [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
] as const;
const relayed = relays.map(async ([from, to]) => {
  for await (const line of createInterface({ input: from, crlfDelay: Number.POSITIVE_INFINITY })) {
    to.write(`${redact(line)}\n`);
  }
});
const code = await new Promise<number>((resolve) => child.on("close", (exitCode) => resolve(exitCode ?? 1)));
await Promise.all(relayed);
console.log(`Live R2 lane: ${redactions} secret or presigned-URL occurrences redacted from the output.`);
process.exit(code);
