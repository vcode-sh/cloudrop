// The command line of `cloudrop`: two commands, a handful of options, `--name value` or `--name=value`.

import { originProblem } from "../server/origins.ts";
import { SETTINGS } from "./names.ts";
import { readVar } from "./vars.ts";

export interface CommandOptions {
  command: "doctor" | "setup";
  /** Exact origins, such as https://app.example.com: checked by the server's own rule, since they are echoed. */
  origins: string[];
  /** Every --env-file, in the order given: a later file's value replaces an earlier one's. */
  envFiles: string[];
  /** --var: the variable each renamed setting is read from, by the setting's cloudrop name (M11-C1). */
  vars: Map<string, string>;
  jurisdiction?: "eu" | "fedramp";
  apply: boolean;
  dryRun: boolean;
  replace: boolean;
}

export type ParsedArgs = { help: true } | { help: false; options: CommandOptions } | { help: false; error: string };

export const USAGE = `Usage: cloudrop <doctor|setup> --origin <origin> [options]

Commands:
  doctor   Check the storage settings, the bucket and its CORS and lifecycle rules.
  setup    Print the bucket's CORS and lifecycle rules and the commands that set them.
           With --apply, add them to the bucket and keep every other rule.

Options:
  --origin <origin>       An origin your pages upload from, such as https://app.example.com.
                          Repeat it for each origin. Required.
  --env-file <path>       Also read settings from this file of NAME=value lines. A variable
                          set in the environment wins over the file. Repeat it for each
                          file: a later file wins over an earlier one.
  --var <SETTING>=<NAME>  Read a setting from a variable of your own, such as
                          --var CLOUDROP_R2_BUCKET=R2_BUCKET. Repeat it for each setting.
  --jurisdiction <eu|fedramp>
                          The R2 bucket's jurisdiction, when it has one.
  --apply                 setup: write the rules to the bucket, keeping every other rule.
  --dry-run               setup: show what --apply would write, and write nothing.
  --replace               setup: write even when the current rules cannot be read, which
                          replaces them.
  -h, --help              Show this help.

Settings come from the environment, as cloudrop reads them, or from the variables --var names:
  R2      CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_BUCKET, CLOUDROP_R2_ACCESS_KEY_ID,
          CLOUDROP_R2_SECRET_ACCESS_KEY
  or S3   CLOUDROP_S3_ENDPOINT, CLOUDROP_S3_REGION, CLOUDROP_S3_BUCKET,
          CLOUDROP_S3_ACCESS_KEY_ID, CLOUDROP_S3_SECRET_ACCESS_KEY
  and     CLOUDROP_SECRET
The command prints the names of variables, never their values.

Exit codes: 0 nothing is wrong, 1 a problem was found or a write failed, 2 a usage error.
`;

const SETUP_FLAGS = { "--apply": "apply", "--dry-run": "dryRun", "--replace": "replace" } as const;
const VALUE_OPTIONS = new Set(["--origin", "--env-file", "--var", "--jurisdiction"]);

/** Sets one option that takes a value; returns what is wrong with it, if anything. */
function setValue(options: CommandOptions, name: string, value: string): string | null {
  if (name === "--env-file") {
    options.envFiles.push(value);
    return null;
  }
  if (name === "--var") return readVar(options.vars, value);
  if (name === "--jurisdiction") {
    if (value !== "eu" && value !== "fedramp") {
      return '--jurisdiction must be "eu" or "fedramp". Leave it out for a bucket in the default location.';
    }
    options.jurisdiction = value;
    return null;
  }
  options.origins.push(value);
  return originProblem(value);
}

function setFlag(options: CommandOptions, name: keyof typeof SETUP_FLAGS, inline: string | undefined): string | null {
  if (options.command !== "setup") return `${name} works only with setup.`;
  if (inline !== undefined) return `${name} takes no value.`;
  options[SETUP_FLAGS[name]] = true;
  return null;
}

interface Arg {
  name: string;
  value: string | undefined;
  /** True for `--name=value`. */
  inline: boolean;
  /** Its place on the command line, the command being 1. */
  position: number;
}

/** `--name=value` and `--name value` each as one Arg. */
function splitArgs(args: readonly string[]): Arg[] {
  const split: Arg[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const position = index + 2;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals > 0) split.push({ name: arg.slice(0, equals), value: arg.slice(equals + 1), inline: true, position });
    else split.push({ name: arg, value: VALUE_OPTIONS.has(arg) ? args[++index] : undefined, inline: false, position });
  }
  return split;
}

// An argument the command does not know is repeated only when it is shaped like an option's or a command's name.
// Anything else may be a setting's value typed in the wrong place, and the output may go to a log (M11-R115).
const OPTION_NAME = /^--?[A-Za-z][A-Za-z-]*$/;
const COMMAND_NAME = /^[A-Za-z][A-Za-z-]{0,19}$/;

function unknownArgument({ name, position }: Arg): string {
  if (OPTION_NAME.test(name)) return `Unknown option "${name}". The options are listed below.`;
  const setting = name.slice(0, Math.max(name.indexOf("="), 0));
  if (SETTINGS.includes(setting)) {
    return `${setting} is given as an argument. The command reads settings from the environment or an --env-file, never from its arguments; what follows "=" is not repeated here.`;
  }
  return `Argument ${position} is not an option. It is not repeated here, in case it is a setting's value. The options are listed below.`;
}

function unknownCommand(command: string): string {
  if (command.startsWith("-")) return "Name the command first, doctor or setup, then its options.";
  return COMMAND_NAME.test(command)
    ? `Unknown command "${command}". Use doctor or setup.`
    : "The first argument is not a command. Use doctor or setup.";
}

function readOption(options: CommandOptions, arg: Arg): string | null {
  const { name, value, inline } = arg;
  if (Object.hasOwn(SETUP_FLAGS, name)) {
    return setFlag(options, name as keyof typeof SETUP_FLAGS, inline ? value : undefined);
  }
  if (!VALUE_OPTIONS.has(name)) return unknownArgument(arg);
  return value ? setValue(options, name, value) : `${name} needs a value.`;
}

/** Reads the options after the command; returns what is wrong with them, if anything. */
function readOptions(options: CommandOptions, args: readonly string[]): string | null {
  for (const arg of splitArgs(args)) {
    const problem = readOption(options, arg);
    if (problem) return problem;
  }
  return options.origins.length > 0
    ? null
    : "Name at least one origin your pages upload from: --origin https://app.example.com.";
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") return { help: true };
  const [command, ...rest] = argv;
  if (command === undefined) return { help: false, error: "Name a command: doctor or setup." };
  if (command !== "doctor" && command !== "setup") {
    return { help: false, error: unknownCommand(command) };
  }
  const options: CommandOptions = {
    command,
    origins: [],
    envFiles: [],
    vars: new Map(),
    apply: false,
    dryRun: false,
    replace: false,
  };
  const error =
    readOptions(options, rest) ??
    (options.replace && !options.apply && !options.dryRun ? "--replace works only with --apply or --dry-run." : null);
  if (error) return { help: false, error };
  // The same origin twice would only repeat it in the rule.
  options.origins = [...new Set(options.origins)];
  return { help: false, options };
}

/** The origins and --var pairs of this run, for a command the output tells the reader to run next (M11-C4). */
export const sameArguments = ({ origins, vars }: CommandOptions): string =>
  [
    ...origins.map((origin) => `--origin ${origin}`),
    ...[...vars].map(([setting, name]) => `--var ${setting}=${name}`),
  ].join(" ");
