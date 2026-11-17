// Settings from the environment (CLOUDROP_SECRET, a storage preset's variables) are read on the first request, not in
// createCloudrop(), so a build with no secrets (next build) can import the server (M4-F16). Each request reads them
// again until they are complete; after that they are kept.

import { fromEnv } from "../env.ts";
import { configError, fail, ok, type Result } from "../errors.ts";
import type { StorageDriver } from "../storage/driver.ts";
import { readSetting, storageSettingsProblem } from "../storage/lazy-driver.ts";
import { importTokenKeys, type TokenKeys } from "./token.ts";

const MIN_SECRET_LENGTH = 32;

function readSecrets(secret: unknown): [string, ...string[]] {
  const secrets = secret === undefined ? [fromEnv("CLOUDROP_SECRET")].filter(Boolean) : [secret].flat();
  if (secrets.length === 0) {
    throw configError(
      "Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); generate one with `openssl rand -base64 32`.",
    );
  }
  // The secret itself is never quoted: messages end up in logs.
  if (!secrets.every((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH)) {
    const which = secret === undefined ? "CLOUDROP_SECRET" : "Each upload token secret";
    throw configError(
      `${which} must be text of at least 32 characters. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return secrets as [string, ...string[]];
}

/**
 * The token keys once every environment setting is present, or one INVALID_CONFIG naming everything still missing. A
 * secret passed as an option is checked now, as every option is; in development so is CLOUDROP_SECRET, so a dev server
 * fails at start.
 */
export function environmentReader(secret: unknown, storage: StorageDriver): () => Promise<Result<TokenKeys>> {
  let tokenKeys =
    secret !== undefined || fromEnv("NODE_ENV") === "development" ? importTokenKeys(readSecrets(secret)) : undefined;
  let resolved: Result<TokenKeys> | undefined;
  return async () => {
    if (resolved) return resolved;
    const keys = tokenKeys ? ok(tokenKeys) : readSetting(() => importTokenKeys(readSecrets(secret)));
    if (keys.data) tokenKeys = keys.data;
    const storageProblem = storageSettingsProblem(storage);
    if (keys.error || storageProblem) {
      return fail(configError([storageProblem?.message, keys.error?.message].filter(Boolean).join(" ")));
    }
    resolved = ok(await keys.data);
    return resolved;
  };
}
