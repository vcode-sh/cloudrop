// The cloudrop command with everything it touches injected, so tests run it as the bin does: arguments, environment,
// file reading, output streams and fetch. It returns the exit code instead of exiting.

import type { FetchLike } from "../storage/driver.ts";
import { parseArgs, USAGE } from "./args.ts";
import { doctor } from "./doctor.ts";
import { printInstructions } from "./instructions.ts";
import type { Output } from "./report.ts";
import { readVariables, serviceOf } from "./settings.ts";
import { applySetup } from "./setup.ts";

export interface CommandIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** Reads a text file; throws an error with a `code` such as ENOENT when it cannot. */
  readFile(path: string): string;
  fetch: FetchLike;
  stdout: Output;
  stderr: Output;
}

const USAGE_ERROR = 2;

export async function runCommand(io: CommandIo): Promise<number> {
  const parsed = parseArgs(io.argv);
  if (parsed.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    io.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return USAGE_ERROR;
  }
  const { options } = parsed;
  const read = readVariables(io.env, options, io.readFile);
  if ("error" in read) {
    io.stderr.write(`${read.error}\n`);
    return USAGE_ERROR;
  }
  const { settings, notes } = read;
  const context = { fetch: io.fetch, out: io.stdout };
  if (options.command === "doctor") return doctor(options, settings, notes, context);
  if (options.apply || options.dryRun) return applySetup(options, settings, notes, context);
  printInstructions(io.stdout, {
    origins: options.origins,
    service: serviceOf(settings),
    jurisdiction: options.jurisdiction,
    name: settings.name,
  });
  return 0;
}
