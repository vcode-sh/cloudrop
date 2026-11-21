// What the command makes of its settings: the storage driver, built from them the way the presets build it, and the
// secret. Every message names a variable, never its value.

import type { FetchLike } from "../storage/driver.ts";
import { R2_VARIABLES, storageFromVariables } from "../storage/presets.ts";
import type { S3Driver } from "../storage/s3-driver.ts";
import { listed, renamed, SECRET, SERVICE_SETTINGS, type Service, type Settings } from "./names.ts";
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
