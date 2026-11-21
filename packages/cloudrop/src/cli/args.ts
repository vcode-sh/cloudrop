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

export type ParsedArgs = { show: "help" | "version" } | { options: CommandOptions } | { error: string };

const SETUP_FLAGS = { "--apply": "apply", "--dry-run": "dryRun", "--replace": "replace" } as const;
const VALUE_OPTIONS = new Set(["--origin", "--env-file", "--var", "--jurisdiction"]);

// A refused origin is repeated only when it is written as one, scheme://host[:port] with at most a last "/". A URL
// with a path or a query may hold a token, as a presigned URL does, and other text may be a setting's value pasted in
// the wrong place (M11-R234). One with an "@" has the origin rule's own sentence, which repeats nothing.
const WRITTEN_AS_ORIGIN = /^[^:/?#\s]+:\/\/[^/?#\s]*\/?$/;

/** What is wrong with the `number`th --origin, if anything. */
function originOption(value: string, number: number): string | null {
  if (WRITTEN_AS_ORIGIN.test(value) || value.includes("@")) return originProblem(value);
  const problem = originProblem(value, `--origin number ${number}`);
  return (
    problem &&
    `${problem} Its value is not repeated here, in case it holds a secret: only text written as scheme://host[:port] is.`
  );
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
    if (options.jurisdiction) return "--jurisdiction is given twice. A bucket has one jurisdiction: give it once.";
    options.jurisdiction = value;
    return null;
  }
  options.origins.push(value);
  return originOption(value, options.origins.length);
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

// An argument the command does not know is repeated only when it is shaped like an option's name. Anything else may
// be a setting's value typed in the wrong place, and the output may go to a log (M11-R115).
const OPTION_NAME = /^--?[A-Za-z][A-Za-z-]*$/;

function unknownArgument({ name, position }: Arg): string {
  if (OPTION_NAME.test(name)) return `Unknown option "${name}". The options are listed below.`;
  const setting = name.slice(0, Math.max(name.indexOf("="), 0));
  if (SETTINGS.includes(setting)) {
    return `${setting} is given as an argument. The command reads settings from the environment or an --env-file, never from its arguments; what follows "=" is not repeated here.`;
  }
  return `Argument ${position} is not an option. It is not repeated here, in case it is a setting's value. The options are listed below.`;
}

// The word typed as the command is never repeated: one of letters may be a key ID (M11-R234).
const unknownCommand = (command: string): string =>
  command.startsWith("-")
    ? "Name the command first, doctor or setup, then its options."
    : "The first argument is not a command. Use doctor or setup.";

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
  // Help wins wherever an option's name can stand, never as an option's value: a file may be named "-h" (M11-R174).
  if (argv[0] === "help" || splitArgs(argv).some(({ name }) => name === "--help" || name === "-h")) {
    return { show: "help" };
  }
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") return { show: "version" };
  if (command === undefined) return { error: "Name a command: doctor or setup." };
  if (command !== "doctor" && command !== "setup") return { error: unknownCommand(command) };
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
  if (error) return { error };
  // The same origin twice would only repeat it in the rule.
  options.origins = [...new Set(options.origins)];
  return { options };
}
