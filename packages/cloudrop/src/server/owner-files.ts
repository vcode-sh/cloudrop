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
/** The store's cursor, `<milliseconds>:<id>`: anything else is refused here, before the store sees it. */
const CURSOR = /^\d{1,15}:.+$/s;

/** The listing the store is asked for, every option checked. */
interface FilesQuery {
  owner: string;
  route: string | null;
  limit: number;
  cursor: string | null;
}

/** An owner or a file id: 1 to 255 characters. */
export const isOwnerOrId = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= MAX_OWNER_LENGTH;

export const badOwner = (): Result<never> =>
  fail(invalidInput(`Pass the owner, a string of 1 to ${MAX_OWNER_LENGTH} characters, as owner() returned it.`));

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
  if (cursor !== undefined && (typeof cursor !== "string" || !CURSOR.test(cursor))) {
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
