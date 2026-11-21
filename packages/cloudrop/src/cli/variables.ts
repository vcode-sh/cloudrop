// Where the command's settings come from: the environment, with the --env-file files under it, as Node's --env-file
// puts them there (M11-R113). Every message names a variable, never its value.

import type { CommandOptions } from "./args.ts";
import { parseEnvFile } from "./env-file.ts";
import { misspelt } from "./misspelt.ts";
import { listed, SERVICE_SETTINGS, SETTINGS, type Settings } from "./names.ts";
import type { Finding } from "./report.ts";

const READ_ADVICE = new Map([
  ["EISDIR", "Name a file, not a directory."],
  ["EACCES", "Check that you may read it."],
]);

const BYTE_ORDER_MARK = "﻿";

/** A variable an env file sets, and the file that gave it its value. */
interface FromFile {
  value: string;
  path: string;
}

const note = (text: string): Finding => ({ status: "note", text });

/** An error code as the file system writes one, such as ENOENT. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * The files' variables, a later file's value replacing an earlier one's as with Node, or why a file cannot be read, by
 * an error code only. A path that cannot be read is not repeated: text typed after --env-file by mistake may be a
 * setting's value (M11-R115).
 */
function readEnvFiles(
  paths: readonly string[],
  readFile: (path: string) => string,
): { file: Map<string, FromFile>; notes: Finding[] } | { error: string } {
  const file = new Map<string, FromFile>();
  const notes: Finding[] = [];
  for (const [index, path] of paths.entries()) {
    let text: string;
    try {
      text = readFile(path);
    } catch (error) {
      // Only the code: a message could quote the file.
      const code = (error as { code?: unknown } | null)?.code;
      const known = typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown error";
      const which = paths.length === 1 ? "the --env-file" : `--env-file number ${index + 1}`;
      return { error: `Cannot read ${which} (${known}). ${READ_ADVICE.get(known) ?? "Check its path."}` };
    }
    const values = parseEnvFile(text);
    // Node keeps the mark in the name, so the variable the file means is never set.
    const marked = [...values.keys()].find((name) => name.startsWith(BYTE_ORDER_MARK));
    if (marked) {
      notes.push(
        note(
          `${path} starts with a byte order mark, so Node's --env-file does not set ${marked.slice(1)}, its first variable. Save the file as UTF-8 without a byte order mark.`,
        ),
      );
    }
    for (const [name, value] of values) file.set(name, { value, path });
  }
  return { file, notes };
}

/**
 * The settings, each read from its variable (its cloudrop name, or the one --var gives it) in the environment with the
 * env files under it. A variable the environment has wins, even one set to nothing, which the library reads as not
 * set. Notes name each variable set in both, each name that looks like a misspelt one, each cloudrop name --var keeps
 * from being read, and settings of two services (M11-C5).
 */
export function readVariables(
  env: Readonly<Record<string, string | undefined>>,
  { envFiles, vars }: Pick<CommandOptions, "envFiles" | "vars">,
  readFile: (path: string) => string,
): { settings: Settings; notes: Finding[] } | { error: string } {
  const read = readEnvFiles(envFiles, readFile);
  if ("error" in read) return read;
  const { file, notes } = read;
  // Own properties only: a variable may be named __proto__ or constructor, which every object has (M11-R117).
  const inEnvironment = (name: string) => (Object.hasOwn(env, name) ? env[name] : undefined);
  const variable = (name: string) => (inEnvironment(name) ?? file.get(name)?.value) || undefined;
  const name = (setting: string) => vars.get(setting) ?? setting;
  const value = (setting: string) => variable(name(setting));
  for (const each of SETTINGS.map(name)) {
    const [own, fromFile] = [inEnvironment(each), file.get(each)];
    if (own === undefined || !fromFile?.value) continue;
    const text = own
      ? `${each} is set in the environment and in ${fromFile.path}; the environment's value is used.`
      : `${each} is set to nothing in the environment, which wins over its value in ${fromFile.path}, as with Node's --env-file. Unset it there to use the file's value.`;
    notes.push(note(text));
  }
  const present = [...Object.keys(env), ...file.keys()].filter((each) => !each.startsWith(BYTE_ORDER_MARK));
  notes.push(...misspelt(present, (each) => variable(each) !== undefined, name));
  for (const setting of SETTINGS.filter((each) => name(each) !== each && variable(each))) {
    notes.push(note(`${setting} is set, but --var reads that setting from ${name(setting)}, so it is not read.`));
  }
  const r2 = SERVICE_SETTINGS.R2.filter(value).map(name);
  if (r2.length > 0 && SERVICE_SETTINGS.S3.some(value)) {
    const text = `Settings for R2 and for S3 are both set; the command checks R2. To check S3, unset ${listed(r2)}.`;
    notes.push(note(text));
  }
  return { settings: { name, value }, notes };
}
