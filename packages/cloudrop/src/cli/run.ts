// The cloudrop command with everything it touches injected, so tests run it as the bin does: arguments, environment,
// file reading, output streams and fetch. It returns the exit code instead of exiting.

import type { FetchLike } from "../storage/driver.ts";
import { parseArgs } from "./args.ts";
import { cloudropCommand, runnerOf, targetOf } from "./commands.ts";
import { doctor } from "./doctor.ts";
import { printInstructions } from "./instructions.ts";
import { listed, SERVICE_SETTINGS } from "./names.ts";
import type { Output } from "./report.ts";
import { readStorage } from "./settings.ts";
import { applySetup } from "./setup.ts";
import { usage } from "./usage.ts";
import { readVariables } from "./variables.ts";

export interface CommandIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** The package's version, for --version. */
  version: string;
  /** Reads a text file; throws an error with a `code` such as ENOENT when it cannot. */
  readFile(path: string): string;
  fetch: FetchLike;
  stdout: Output;
  stderr: Output;
}

const USAGE_ERROR = 2;

export async function runCommand(io: CommandIo): Promise<number> {
  const runner = runnerOf(io.env);
  const parsed = parseArgs(io.argv);
  if ("show" in parsed) {
    io.stdout.write(parsed.show === "help" ? usage(runner) : `${io.version}\n`);
    return 0;
  }
  if ("error" in parsed) {
    io.stderr.write(`${parsed.error}\n\n${usage(runner)}`);
    return USAGE_ERROR;
  }
  const { options } = parsed;
  const read = readVariables(io.env, options, io.readFile);
  if ("error" in read) {
    io.stderr.write(`${read.error}\n`);
    return USAGE_ERROR;
  }
  const { settings, notes } = read;
  const storage = readStorage(settings, { jurisdiction: options.jurisdiction, fetch: io.fetch });
  // Only R2 has jurisdictions: on another service the option would change nothing, silently (M11-R118).
  if (options.jurisdiction && storage.service === "S3") {
    const found = listed(SERVICE_SETTINGS.S3.filter(settings.value).map(settings.name));
    io.stderr.write(
      `--jurisdiction is for an R2 bucket, and the settings found are for S3 (${found}). Leave it out.\n`,
    );
    return USAGE_ERROR;
  }
  const context = { out: io.stdout, runner };
  if (options.command === "doctor") return doctor(options, settings, storage, notes, context);
  if (options.apply || options.dryRun) return applySetup(options, settings, storage, notes, context);
  printInstructions(io.stdout, {
    origins: options.origins,
    service: storage.service,
    jurisdiction: options.jurisdiction,
    runner,
    target: targetOf(settings, storage),
    apply: cloudropCommand(runner, "setup", options, "--apply"),
  });
  return 0;
}
