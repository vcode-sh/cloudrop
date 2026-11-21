// api.files (M8-A1): an owner's completed files, newest first, a page at a time, straight from the store's rows.

import { fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { MAX_OWNER_LENGTH } from "./store-upload.ts";

export interface FilesOptions {
  /** The owner, as the route's `owner` callback returned it. */
  owner: string;
  /** Only this route's files. */
  route?: string;
  /** Files per page, 1 to 1000. Default 100. */
  limit?: number;
  /** The `cursor` an earlier page answered, to read the next one. */
  cursor?: string;
}

export interface FilesPage {
  /** The files' rows, newest upload first. */
  items: FileRecord[];
  /** Pass it back to read the next page; null on the last one. */
  cursor: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** The last time an ISO string without a sign names, which is how Postgres is given a time: 9999-12-31T23:59:59.999Z. */
const LAST_TIME_MS = 253_402_300_799_999;

/** The listing the store is asked for, every option checked. */
interface FilesQuery {
  owner: string;
  route: string | null;
  limit: number;
  cursor: string | null;
}

/**
 * An owner or a file id: 1 to 255 characters, none of them NUL. Postgres text cannot hold U+0000, so no row has one, and
 * the store would fail on it: refused here, it is the caller's mistake and not a retryable SERVER_ERROR.
 */
export const isOwnerOrId = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= MAX_OWNER_LENGTH && !value.includes("\u0000");

export const badOwner = (): Result<never> =>
  fail(
    invalidInput(
      `Pass the owner, a string of 1 to ${MAX_OWNER_LENGTH} characters without NUL (U+0000), as owner() returned it.`,
    ),
  );

/**
 * A store cursor, `<milliseconds>:<id>`, as `list` and `stale` make them: refused before the store sees it when it has
 * another shape, or a time or an id no row can have.
 */
export function isStoreCursor(cursor: string): boolean {
  const match = /^(\d{1,15}):(.+)$/s.exec(cursor);
  return match !== null && Number(match[1]) <= LAST_TIME_MS && isOwnerOrId(match[2]);
}

function readOptions(config: ServerConfig, given: unknown): Result<FilesQuery> {
  if (!isPlainObject(given))
    return fail(invalidInput("files takes { owner }, and optionally route, limit and cursor."));
  const { owner, route, limit = DEFAULT_LIMIT, cursor } = given;
  if (!isOwnerOrId(owner)) return badOwner();
  if (route !== undefined && (typeof route !== "string" || !config.routes.has(route))) {
    const names = [...config.routes.keys()].map((name) => JSON.stringify(name)).join(", ");
    return fail(invalidInput(`route must be one of this server's routes: ${names}.`));
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return fail(invalidInput(`limit must be a whole number from 1 to ${MAX_LIMIT}.`));
  }
  if (cursor !== undefined && (typeof cursor !== "string" || !isStoreCursor(cursor))) {
    return fail(invalidInput("cursor must be one an earlier page of files returned. Leave it out for the first page."));
  }
  return ok({ owner, route: route ?? null, limit, cursor: cursor ?? null });
}

export async function listFiles(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown,
): Promise<Result<FilesPage>> {
  const options = readOptions(config, given);
  if (options.error) return options;
  const { owner } = options.data;
  const page = await storeCall(config.logger, `list the files of ${owner}`, () =>
    store.list({ ...options.data, statuses: ["completed"] }),
  );
  return page.error ? page : ok({ items: page.data.records, cursor: page.data.cursor });
}
