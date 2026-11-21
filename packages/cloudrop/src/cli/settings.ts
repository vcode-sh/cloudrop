// The settings the command reads: the environment, an optional env file, and the storage driver built from them the
// way the presets build it. Every message names a variable, never its value.

import type { FetchLike } from "../storage/driver.ts";
import { R2_VARIABLES, storageFromVariables } from "../storage/presets.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import type { CommandOptions } from "./args.ts";
import { parseEnvFile } from "./env-file.ts";
import { misspelt } from "./misspelt.ts";
import { listed, renamed, SECRET, SERVICE_SETTINGS, SETTINGS, type Service, type Settings } from "./names.ts";
import type { Finding } from "./report.ts";

const MIN_SECRET_LENGTH = 32;

const WHAT_TO_SET: Record<string, string> = {
  CLOUDROP_R2_ACCOUNT_ID: "the account ID on the R2 overview page of the Cloudflare dashboard",
  CLOUDROP_R2_BUCKET: "the bucket's name",
  CLOUDROP_R2_ACCESS_KEY_ID: "the access key ID of an R2 API token",
  CLOUDROP_R2_SECRET_ACCESS_KEY: "the secret access key of an R2 API token",
  CLOUDROP_S3_ENDPOINT: "the service's S3 endpoint, such as https://s3.us-east-1.amazonaws.com",
  CLOUDROP_S3_REGION: "the bucket's region, such as us-east-1",
  CLOUDROP_S3_BUCKET: "the bucket's name",
  CLOUDROP_S3_ACCESS_KEY_ID: "the access key ID of the service's credentials",
  CLOUDROP_S3_SECRET_ACCESS_KEY: "the secret access key of the service's credentials",
};

const READ_ADVICE = new Map([
  ["EISDIR", "Name a file, not a directory."],
  ["EACCES", "Check that you may read it."],
]);

/** The file's values, or why it cannot be read, by its path and an error code only. */
function readEnvFile(
  path: string,
  readFile: (path: string) => string,
): { values: Record<string, string> } | { error: string } {
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    // Only the code: a message could quote the file.
    const code = (error as { code?: unknown } | null)?.code;
    const known = typeof code === "string" ? code : "unknown error";
    return { error: `Cannot read ${path} (${known}). ${READ_ADVICE.get(known) ?? "Check the path."}` };
  }
  return { values: parseEnvFile(text) };
}

/**
 * The settings, each read from its variable (its cloudrop name, or the one --var gives it) in the environment with an
 * env file under it: a variable set in the environment wins, as with Node's --env-file. Notes name each variable set in
 * both, each name that looks like a misspelt one, each cloudrop name --var keeps from being read, and settings of two
 * services (M11-C5). The file is reported by its path and error code only.
 */
export function readVariables(
  env: Readonly<Record<string, string | undefined>>,
  { envFile, vars }: Pick<CommandOptions, "envFile" | "vars">,
  readFile: (path: string) => string,
): { settings: Settings; notes: Finding[] } | { error: string } {
  const read = envFile === undefined ? { values: {} } : readEnvFile(envFile, readFile);
  if ("error" in read) return read;
  const file: Record<string, string> = read.values;
  const variable = (name: string) => env[name] || file[name] || undefined;
  const name = (setting: string) => vars.get(setting) ?? setting;
  const value = (setting: string) => variable(name(setting));
  const note = (text: string): Finding => ({ status: "note", text });
  const notes = SETTINGS.map(name)
    .filter((each) => env[each] && file[each])
    .map((each) => note(`${each} is set in the environment and in ${envFile}; the environment's value is used.`));
  notes.push(...misspelt([...Object.keys(env), ...Object.keys(file)], (each) => variable(each) !== undefined, name));
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

/** R2 when any R2 setting is set, else S3 when any S3 setting is, else none. */
export function serviceOf({ value }: Settings): Service | undefined {
  if (SERVICE_SETTINGS.R2.some(value)) return "R2";
  return SERVICE_SETTINGS.S3.some(value) ? "S3" : undefined;
}

export interface StorageSettings {
  service: Service | undefined;
  driver: S3Driver | undefined;
  findings: Finding[];
}

/** The driver when every storage setting is present and valid; otherwise a finding for each one that is not. */
export function readStorage(
  settings: Settings,
  options: { jurisdiction?: "eu" | "fedramp"; fetch: FetchLike },
): StorageSettings {
  const { name, value } = settings;
  const service = serviceOf(settings);
  if (service === undefined) {
    const { accountId, bucket, accessKeyId, secretAccessKey } = R2_VARIABLES;
    const forR2 = listed([accountId, bucket, accessKeyId, secretAccessKey].map(name));
    const s3 = renamed(name, "S3");
    const text = `No storage settings found. Set ${forR2} for R2, or ${s3 ? listed(s3) : "the CLOUDROP_S3_* settings"} for another service; --env-file reads them from a file.`;
    return { service, driver: undefined, findings: [{ status: "problem", text }] };
  }
  const missing = SERVICE_SETTINGS[service].filter((setting) => !value(setting));
  if (missing.length > 0) {
    const findings = missing.map(
      (setting): Finding => ({
        status: "problem",
        text: `${name(setting)} is not set. Set it to ${WHAT_TO_SET[setting]}.`,
      }),
    );
    return { service, driver: undefined, findings };
  }
  // The settings are all set, so the only message of the storage's that names one is about an invalid value.
  const built = storageFromVariables(service, value, { ...options, name });
  if (built.error) return { service, driver: undefined, findings: [{ status: "problem", text: built.error.message }] };
  const read = renamed(name, service)?.join(", ") ?? `CLOUDROP_${service}_*`;
  return {
    service,
    driver: built.data,
    findings: [{ status: "ok", text: `${service} settings are present and valid (${read}).` }],
  };
}

export function secretFinding({ name, value }: Settings): Finding {
  const secret = value(SECRET);
  if (!secret) {
    return {
      status: "problem",
      text: `${name(SECRET)} is not set. Generate one with \`openssl rand -base64 32\` and set it, unless your code passes secret to createCloudrop().`,
    };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      status: "problem",
      text: `${name(SECRET)} has fewer than ${MIN_SECRET_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`,
    };
  }
  return { status: "ok", text: `${name(SECRET)} is set.` };
}
