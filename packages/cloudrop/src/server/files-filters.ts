// The filters and the order api.files and api.allFiles share (M10-D1): a route of this server, a name as `/upload`
// stores names, a type or a top-level type, and newest or oldest first.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput } from "../input.ts";
import { MAX_NAME_LENGTH } from "../protocol/types.ts";
import type { ServerConfig } from "./config.ts";

/** A listing's filters, each null for none, and its order. */
export interface FileFilters {
  route: string | null;
  name: string | null;
  type: string | null;
  order: "newest" | "oldest";
}

/** A type, or a top-level type and its slash, as `/upload` stores types (lower case, RFC 6838 names). */
const TYPE_FILTER = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(?:[a-z0-9][a-z0-9!#$&^_.+-]{0,63})?$/;

/**
 * The name filter as `/upload` checks and stores names: well-formed, in NFC, at most 255 characters once normalized. Or
 * null for none: an empty name filters nothing.
 */
function readName(name: unknown): Result<string | null> {
  if (name === undefined || name === "") return ok(null);
  const normalized = typeof name === "string" && name.isWellFormed() ? name.normalize("NFC") : "\u0000";
  if ([...normalized].length <= MAX_NAME_LENGTH && !normalized.includes("\u0000")) return ok(normalized);
  return fail(
    invalidInput(
      `name must be text of at most ${MAX_NAME_LENGTH} characters, without NUL (U+0000) or lone surrogates.`,
    ),
  );
}

function readType(type: unknown): Result<string | null> {
  if (type === undefined) return ok(null);
  const lower = typeof type === "string" ? type.toLowerCase() : "";
  if (TYPE_FILTER.test(lower)) return ok(lower);
  return fail(invalidInput('type must be a type such as "application/pdf", or a top-level type such as "image/".'));
}

export function readFilters(config: ServerConfig, given: Record<string, unknown>): Result<FileFilters> {
  const { route, order = "newest" } = given;
  if (route !== undefined && (typeof route !== "string" || !config.routes.has(route))) {
    const names = [...config.routes.keys()].map((name) => JSON.stringify(name)).join(", ");
    return fail(invalidInput(`route must be one of this server's routes: ${names}.`));
  }
  if (order !== "newest" && order !== "oldest") return fail(invalidInput('order must be "newest" or "oldest".'));
  const name = readName(given.name);
  if (name.error) return name;
  const type = readType(given.type);
  return type.error ? type : ok({ route: route ?? null, name: name.data, type: type.data, order });
}
