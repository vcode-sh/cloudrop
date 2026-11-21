// The commands the output tells its reader to run: cloudrop's own, Wrangler's and the AWS CLI's. Each is complete and
// quoted for a POSIX shell, so it runs as printed in the directory the command ran in (M11-R110).

import type { CommandOptions } from "./args.ts";
import type { Settings } from "./names.ts";
import type { StorageSettings } from "./settings.ts";

/** What starts a package's bin for the person who ran the command: `npx`, `bunx` or `pnpm exec`. */
export type Runner = "npx" | "bunx" | "pnpm exec";

/**
 * The runner that started the command, read from the user agent npm, Bun and pnpm give what they start (measured
 * 2026-11-21: npm 11, Bun 1.4, pnpm 12). `npx` for any other start: it finds the bin of an installed package, which a
 * bare `cloudrop` does not.
 */
export function runnerOf(env: Readonly<Record<string, string | undefined>>): Runner {
  const agent = (Object.hasOwn(env, "npm_config_user_agent") && env.npm_config_user_agent) || "";
  if (agent.startsWith("bun/")) return "bunx";
  return agent.startsWith("pnpm/") ? "pnpm exec" : "npx";
}

// Text no POSIX shell reads as anything but itself. A leading "=" is left out: zsh expands a word that starts with one.
const PLAIN_WORD = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/** `word` as one word of a shell command: in single quotes unless it is plain text. */
export const quote = (word: string): string => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** `<runner> cloudrop <command>` with this run's origins, env files, --var pairs and jurisdiction, then `flags`. */
export function cloudropCommand(
  runner: Runner,
  command: CommandOptions["command"],
  { origins, envFiles, vars, jurisdiction }: CommandOptions,
  ...flags: string[]
): string {
  const words = [
    "cloudrop",
    command,
    ...origins.flatMap((origin) => ["--origin", origin]),
    ...envFiles.flatMap((path) => ["--env-file", path]),
    ...[...vars].flatMap(([setting, name]) => ["--var", `${setting}=${name}`]),
    ...(jurisdiction ? ["--jurisdiction", jurisdiction] : []),
    ...flags,
  ];
  return `${runner} ${words.map(quote).join(" ")}`;
}

/**
 * What a Wrangler or AWS CLI command acts on, each as a word of the command: the bucket's name and the S3 endpoint,
 * which are not secrets, once the storage settings are all set and valid, and a placeholder until then.
 */
export interface Target {
  bucket: string;
  endpoint: string;
  /** True when `bucket` and `endpoint` are placeholders for the reader to replace. */
  placeholders: boolean;
}

export function targetOf({ value }: Settings, { service, driver }: StorageSettings): Target {
  if (!driver || !service) return { bucket: "<bucket>", endpoint: "<endpoint>", placeholders: true };
  return {
    bucket: quote(value(service === "R2" ? "CLOUDROP_R2_BUCKET" : "CLOUDROP_S3_BUCKET") ?? ""),
    endpoint: quote(value("CLOUDROP_S3_ENDPOINT") ?? ""),
    placeholders: false,
  };
}

/** A Wrangler command for the bucket, with the jurisdiction when it has one. `args` names the bucket as <bucket>. */
export function wrangler(runner: Runner, args: string, { bucket }: Target, jurisdiction: string | undefined): string {
  const command = `${runner} wrangler r2 bucket ${args.replace("<bucket>", bucket)}`;
  return jurisdiction ? `${command} --jurisdiction ${jurisdiction}` : command;
}

/** An AWS CLI call for the bucket at the S3 endpoint. */
export function aws(call: string, { bucket, endpoint }: Target, args = ""): string {
  return `aws s3api ${call} --bucket ${bucket}${args} --endpoint-url ${endpoint}`;
}
