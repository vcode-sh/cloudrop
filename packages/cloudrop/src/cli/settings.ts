// The settings the command reads: the environment, an optional env file, and the storage driver built from them the
// way the presets build it. Every message names a variable, never its value.

import type { FetchLike } from "../storage/driver.ts";
import { R2_VARIABLES, S3_VARIABLES, storageFromVariables } from "../storage/presets.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import { parseEnvFile } from "./env-file.ts";
import type { Finding } from "./report.ts";

export type Variables = (name: string) => string | undefined;
export type Service = "R2" | "S3";

const NAMES: Record<Service, string[]> = { R2: Object.values(R2_VARIABLES), S3: Object.values(S3_VARIABLES) };
const SECRET = "CLOUDROP_SECRET";
const KNOWN = [...NAMES.R2, ...NAMES.S3, SECRET];
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
 * The environment with an env file under it: a variable set in the environment wins, as with Node's --env-file. Notes
 * name each cloudrop variable set in both, each name that looks like a misspelt setting, and settings of two services.
 * The file is reported by its path and error code only.
 */
export function readVariables(
  env: Readonly<Record<string, string | undefined>>,
  envFile: string | undefined,
  readFile: (path: string) => string,
): { variables: Variables; notes: Finding[] } | { error: string } {
  const read = envFile === undefined ? { values: {} } : readEnvFile(envFile, readFile);
  if ("error" in read) return read;
  const file: Record<string, string> = read.values;
  const variables: Variables = (name) => env[name] || file[name] || undefined;
  const notes = KNOWN.filter((name) => env[name] && file[name]).map(
    (name): Finding => ({
      status: "note",
      text: `${name} is set in the environment and in ${envFile}; the environment's value is used.`,
    }),
  );
  notes.push(...misspelt([...Object.keys(env), ...Object.keys(file)], variables));
  if (serviceOf(variables) === "R2" && NAMES.S3.some((name) => variables(name))) {
    const text =
      "CLOUDROP_R2_* and CLOUDROP_S3_* settings are both set; the command checks R2. Unset the CLOUDROP_R2_* settings to check S3.";
    notes.push({ status: "note", text });
  }
  return { variables, notes };
}

/** Edit distance between two names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const replace = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, replace);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// Settings people bring from S3 to R2, which R2 builds or does not need.
const NOT_FOR_R2 = new Map([
  ["CLOUDROP_R2_ENDPOINT", "R2's endpoint is built from CLOUDROP_R2_ACCOUNT_ID."],
  ["CLOUDROP_R2_REGION", "R2 needs no region."],
]);

/** The setting that is not set and is the same name in another case, or two edits from it, in the name's service. */
function meant(upper: string, variables: Variables): string | undefined {
  // CLOUDROP_R2_ENDPOINT is no misspelt CLOUDROP_S3_ENDPOINT: following that advice would change nothing.
  const service = upper.startsWith("CLOUDROP_R2_") ? "R2" : upper.startsWith("CLOUDROP_S3_") ? "S3" : undefined;
  const scored = (service ? NAMES[service] : KNOWN).map((known) => ({ known, score: distance(upper, known) }));
  const best = scored.sort((a, b) => a.score - b.score)[0];
  return best && best.score <= 2 && !variables(best.known) ? `Did you mean ${best.known}?` : undefined;
}

/**
 * A note for each CLOUDROP_* name that is no setting but looks meant as one, such as CLOUDROP_R2_BUCKT: otherwise the
 * only clue is "CLOUDROP_R2_BUCKET is not set" (M9-H103).
 */
function misspelt(names: readonly string[], variables: Variables): Finding[] {
  return [...new Set(names)].flatMap((name): Finding[] => {
    if (!/^cloudrop_/i.test(name) || KNOWN.includes(name)) return [];
    const upper = name.toUpperCase();
    const hint = NOT_FOR_R2.get(upper) ?? meant(upper, variables);
    return hint ? [{ status: "note", text: `${name} is not a cloudrop setting. ${hint}` }] : [];
  });
}

/** R2 when any CLOUDROP_R2_* is set, else S3 when any CLOUDROP_S3_* is, else none. */
export function serviceOf(variables: Variables): Service | undefined {
  if (NAMES.R2.some((name) => variables(name))) return "R2";
  return NAMES.S3.some((name) => variables(name)) ? "S3" : undefined;
}

export interface StorageSettings {
  service: Service | undefined;
  driver: S3Driver | undefined;
  findings: Finding[];
}

/** The driver when every storage setting is present and valid; otherwise a finding for each one that is not. */
export function readStorage(
  variables: Variables,
  options: { jurisdiction?: "eu" | "fedramp"; fetch: FetchLike },
): StorageSettings {
  const service = serviceOf(variables);
  if (service === undefined) {
    const text =
      "No storage settings found. Set CLOUDROP_R2_ACCOUNT_ID, CLOUDROP_R2_BUCKET, CLOUDROP_R2_ACCESS_KEY_ID and CLOUDROP_R2_SECRET_ACCESS_KEY for R2, or the CLOUDROP_S3_* settings for another service; --env-file reads them from a file.";
    return { service, driver: undefined, findings: [{ status: "problem", text }] };
  }
  const missing = NAMES[service].filter((name) => !variables(name));
  if (missing.length > 0) {
    const findings = missing.map(
      (name): Finding => ({ status: "problem", text: `${name} is not set. Set it to ${WHAT_TO_SET[name]}.` }),
    );
    return { service, driver: undefined, findings };
  }
  const built = storageFromVariables(service, variables, options);
  if (built.error) return { service, driver: undefined, findings: [{ status: "problem", text: built.error.message }] };
  const findings: Finding[] = [
    { status: "ok", text: `${service} settings are present and valid (CLOUDROP_${service}_*).` },
  ];
  return { service, driver: built.data, findings };
}

export function secretFinding(variables: Variables): Finding {
  const secret = variables(SECRET);
  if (!secret) {
    return {
      status: "problem",
      text: `${SECRET} is not set. Generate one with \`openssl rand -base64 32\` and set it, unless your code passes secret to createCloudrop().`,
    };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      status: "problem",
      text: `${SECRET} has fewer than ${MIN_SECRET_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`,
    };
  }
  return { status: "ok", text: `${SECRET} is set.` };
}
