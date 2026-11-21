// The command line of `cloudrop`: two commands, a handful of options, `--name value` or `--name=value`.

import { readVar } from "./vars.ts";

export interface CommandOptions {
  command: "doctor" | "setup";
  /** Exact origins, such as https://app.example.com: checked here, since they are echoed in the output. */
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

/** What is wrong with an origin, naming the exact origin when the value is a URL that has one (M9-H100). */
function originProblem(value: string): string | null {
  // A browser never sends a pattern, so a rule or a check for one matches no page (URL accepts * in a host).
  if (value.includes("*")) {
    return `"${value}" is a pattern, not an origin. Name each origin your pages upload from with its own --origin, such as https://app.example.com.`;
  }
  // "null" is the origin of a URL without one (file:, data:), never a page's to name.
  const origin = URL.canParse(value) ? new URL(value).origin : "null";
  if (origin !== "null" && origin === value) return null;
  return origin === "null"
    ? `"${value}" is not an origin. Write it as scheme://host[:port] with no path, such as https://app.example.com.`
    : `"${value}" is not an origin. Use ${origin}: an origin is the scheme, host and port, with no path.`;
}

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
}

/** `--name=value` and `--name value` each as one Arg. */
function splitArgs(args: readonly string[]): Arg[] {
  const split: Arg[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (equals > 0) split.push({ name: arg.slice(0, equals), value: arg.slice(equals + 1), inline: true });
    else split.push({ name: arg, value: VALUE_OPTIONS.has(arg) ? args[++index] : undefined, inline: false });
  }
  return split;
}

function readOption(options: CommandOptions, { name, value, inline }: Arg): string | null {
  if (Object.hasOwn(SETUP_FLAGS, name)) {
    return setFlag(options, name as keyof typeof SETUP_FLAGS, inline ? value : undefined);
  }
  if (!VALUE_OPTIONS.has(name)) return `Unknown option "${name}". Run cloudrop --help to see the options.`;
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
    return { help: false, error: `Unknown command "${command}". Use doctor or setup.` };
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
