// The folders `erase.prefixes` names for an owner (M12-O3), which no row tracks: checked before any is emptied, so no
// prefix reaches another owner's files, then emptied with deletePrefix once the owner's rows are done.

import { CloudropError, configError, fail, ok, type Result } from "../errors.ts";
import { keyProblem } from "../storage/validate.ts";
import { deletePrefix } from "./api.ts";
import type { ServerConfig } from "./config.ts";
import type { Eraser } from "./erase-passes.ts";

/**
 * The owner as one whole segment of a folder prefix, as it is or URI-encoded (M12-O3), so that `() => ["avatars/"]`,
 * which would empty every owner's folder, is refused. Compared in NFC, the form deletePrefix reads a prefix in.
 */
function ownsPrefix(prefix: unknown, owner: string): prefix is string {
  if (typeof prefix !== "string" || !prefix.endsWith("/")) return false;
  const forms = new Set([owner, encodeURIComponent(owner)].map((form) => form.normalize("NFC")));
  return prefix
    .normalize("NFC")
    .split("/")
    .some((segment) => forms.has(segment));
}

// The rule compares one segment and cannot see other owners: for an owner "acme", "exports/acme/" also holds an owner
// "acme/alice"'s "exports/acme/alice/", so only the encoded form keeps owner ids with "/" apart (M12-R7).
const PREFIX_RULE =
  'It must answer a list of folders that end in "/" and each have the owner, as it is or URI-encoded, as one whole segment between slashes, such as "exports/<owner>/", so that no prefix reaches every owner\'s files. If owner ids can contain "/", use encodeURIComponent(owner), or one owner\'s folder holds another\'s.';

/**
 * The route whose own folder `prefix` starts in: a route without `prefix` keeps every owner's files under its name
 * (M12-A10), so `(owner) => [owner + "/"]` would empty that route for an owner named like it (M12-R6).
 */
function sharedFolder({ routes }: ServerConfig, prefix: string): string | undefined {
  const [first] = prefix.split("/");
  for (const { name, definition } of routes.values()) {
    if (!definition.prefix && name.normalize("NFC") === first) return name;
  }
  return undefined;
}

/**
 * Why `erase.prefixes` must not answer `prefix`, or null when it may: it must hold the owner as a segment, start in no
 * route's own folder, and be a prefix some key can start with, or deletePrefix would refuse it on every run and the
 * erasure would never finish.
 */
function prefixProblem(config: ServerConfig, prefix: unknown, owner: string): string | null {
  if (!ownsPrefix(prefix, owner)) return PREFIX_RULE;
  const normalized = prefix.normalize("NFC");
  const route = sharedFolder(config, normalized);
  if (route !== undefined) {
    return `Its first folder is that of route "${route}", which has no prefix and keeps every owner's files under its name. Start each prefix with a folder no such route uses, such as "exports/<owner>/", or give route "${route}" a prefix.`;
  }
  const problem = keyProblem(normalized);
  return problem === null ? null : `No key can start with it: ${problem}`;
}

/** `erase.prefixes(owner)`, each checked before any is emptied. */
export function readPrefixes(config: ServerConfig, owner: string): Result<readonly string[]> {
  if (!config.erasePrefixes) return ok([]);
  let prefixes: unknown;
  try {
    prefixes = config.erasePrefixes(owner);
  } catch (cause) {
    return fail(new CloudropError("INVALID_CONFIG", "erase.prefixes threw; its cause says why. Fix it.", { cause }));
  }
  if (!Array.isArray(prefixes)) return fail(configError(`erase.prefixes answered no list. ${PREFIX_RULE}`));
  for (const prefix of prefixes as unknown[]) {
    const problem = prefixProblem(config, prefix, owner);
    if (problem !== null) {
      return fail(configError(`erase.prefixes answered ${JSON.stringify(prefix) ?? String(prefix)}. ${problem}`));
    }
  }
  return ok(prefixes);
}

/** Empties each prefix in turn, counting what it deleted; a folder that fails is logged and counted in `failed`. */
export async function emptyPrefixes({ config, signal, report }: Eraser, prefixes: readonly string[]): Promise<boolean> {
  for (const prefix of prefixes) {
    if (signal?.aborted) return false;
    const emptied = await deletePrefix(config.storage, prefix.normalize("NFC"));
    if (emptied.error) {
      config.logger.error(`cloudrop: eraseOwner could not empty ${prefix}. Run eraseOwner again.`, emptied.error);
      report.failed += 1;
    } else {
      report.prefixed += emptied.data.deleted;
    }
  }
  return report.failed === 0;
}
