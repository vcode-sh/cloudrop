// api.sweep's options, read once per call: where it starts (a cursor names the pass and the store's own cursor in it),
// how many rows, how long a grace, and whether it runs every page.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import { readGrace } from "./leftovers.ts";
import { isStoreCursor, readLimit } from "./owner-files.ts";

/**
 * The pass, then the store's own cursor (`isStoreCursor`), empty for the cleanup pass's start. A cursor that was edited
 * is refused here, before the store sees it.
 */
const CURSOR = /^(expire|cleanup):(.*)$/s;

export type Pass = "expire" | "cleanup";

/** Where a sweep starts: the pass and the store's cursor in it. */
export interface Position {
  pass: Pass;
  cursor: string | null;
}

export interface Run extends Position {
  limit: number;
  graceMs: number;
  all: boolean;
  signal: AbortSignal | undefined;
}

/** A sweep cursor read back into its position, or null when no sweep made it. */
export function readCursor(cursor: string): Position | null {
  const match = CURSOR.exec(cursor);
  if (!match || (match[2] && !isStoreCursor(match[2]))) return null;
  return { pass: match[1] as Pass, cursor: match[2] || null };
}

function readAll(options: Record<string, unknown>): Result<{ all: boolean; signal: AbortSignal | undefined }> {
  const { all = false, signal } = options;
  if (typeof all !== "boolean") return fail(invalidInput("all must be true or false."));
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return fail(invalidInput("signal must be an AbortSignal, such as AbortSignal.timeout(25_000)."));
  }
  if (signal !== undefined && !all) {
    return fail(invalidInput("signal stops a sweep between pages, so it needs all: true. Pass both, or neither."));
  }
  return ok({ all, signal });
}

export function readOptions(given: unknown): Result<Run> {
  const options = optionsOf(given);
  if (!options) return fail(invalidInput("sweep takes options such as { limit: 100 }."));
  const { cursor } = options;
  const limit = readLimit(options.limit);
  if (limit.error) return limit;
  const graceMs = readGrace(options.graceMs);
  if (graceMs.error) return graceMs;
  const all = readAll(options);
  if (all.error) return all;
  // Null is what a finished sweep answers: it starts over, like no cursor.
  const start =
    cursor == null ? { pass: "expire" as const, cursor: null } : typeof cursor === "string" && readCursor(cursor);
  if (!start) return fail(invalidInput("cursor must be one an earlier sweep returned. Leave it out to start over."));
  return ok({ limit: limit.data, graceMs: graceMs.data, ...all.data, ...start });
}
