// api.files (M8-A1, M10-D1, M10-D2): an owner's completed files, newest or oldest first, optionally filtered by route,
// name and type, a page at a time, straight from the store's rows.

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import { MAX_NAME_LENGTH } from "../protocol/types.ts";
import type { ServerConfig } from "./config.ts";
import type { CloudropStore, FileRecord } from "./store.ts";
import { storeCall } from "./store-calls.ts";
import { MAX_OWNER_LENGTH } from "./store-upload.ts";

export interface FilesOptions {
  /** The owner, as the route's `owner` callback returned it. */
  owner: string;
  /** Only this route's files. */
  route?: string;
  /** Only files whose name contains this, ASCII letters in either case: `"report"` finds `"Q3 Report.pdf"`. */
  name?: string;
  /** Only this type, such as `"application/pdf"`, or every type under a top-level type, such as `"image/"`. */
  type?: string;
  /** `"newest"` upload first (the default) or `"oldest"`. */
  order?: "newest" | "oldest";
  /** Files per page, 1 to 1000. Default 100. */
  limit?: number;
  /** The `cursor` an earlier page answered, to read the next one. Pass the same route, name, type and order. */
  cursor?: string;
}

export interface FilesPage {
  /** The files' rows, in the order asked for. */
  items: FileRecord[];
  /** Pass it back to read the next page; null on the last one. */
  cursor: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** The last time an ISO string without a sign names, which is how Postgres is given a time: 9999-12-31T23:59:59.999Z. */
const LAST_TIME_MS = 253_402_300_799_999;
/** A type, or a top-level type and its slash, as `/upload` stores types (lower case, RFC 6838 names). */
const TYPE_FILTER = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(?:[a-z0-9][a-z0-9!#$&^_.+-]{0,63})?$/;
/** A cursor of a filtered or oldest-first listing: the listing's fingerprint, a dot, then the store's cursor. */
const FILTERED_CURSOR = /^(?:([0-9a-f]{8})\.)?(.*)$/s;

/** The listing the store is asked for, every option checked. */
interface FilesQuery {
  owner: string;
  route: string | null;
  name: string | null;
  type: string | null;
  order: "newest" | "oldest";
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

/**
 * Which listing a cursor belongs to: FNV-1a of its route, name, type and order, so a cursor passed with other filters is
 * refused instead of paging a listing it was not made for. The default listing has none, so its cursors stay the plain
 * store cursors of 0.3.
 */
function fingerprint({ route, name, type, order }: Pick<FilesQuery, "route" | "name" | "type" | "order">): string {
  if (route === null && name === null && type === null && order === "newest") return "";
  const text = JSON.stringify([route, name, type, order]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

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

function readFilters(
  config: ServerConfig,
  given: Record<string, unknown>,
): Result<Pick<FilesQuery, "route" | "name" | "type" | "order">> {
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

/** The store's cursor inside the caller's, refused when it is malformed or belongs to another listing than `mark`'s. */
function readCursor(cursor: unknown, mark: string): Result<string | null> {
  if (cursor === undefined) return ok(null);
  const [, given = "", position = ""] = (typeof cursor === "string" && FILTERED_CURSOR.exec(cursor)) || [];
  if (!isStoreCursor(position)) {
    return fail(invalidInput("cursor must be one an earlier page of files returned. Leave it out for the first page."));
  }
  if (given !== mark) {
    return fail(
      invalidInput(
        "cursor belongs to a listing with another route, name, type or order. Pass the options of the page that returned it, or leave cursor out to start again.",
      ),
    );
  }
  return ok(position);
}

/** The listing the store is asked for, and the fingerprint its cursors carry. */
function readOptions(config: ServerConfig, given: unknown): Result<{ query: FilesQuery; mark: string }> {
  if (!isPlainObject(given)) {
    return fail(invalidInput("files takes { owner }, and optionally route, name, type, order, limit and cursor."));
  }
  const { owner, limit = DEFAULT_LIMIT } = given;
  if (!isOwnerOrId(owner)) return badOwner();
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return fail(invalidInput(`limit must be a whole number from 1 to ${MAX_LIMIT}.`));
  }
  const filters = readFilters(config, given);
  if (filters.error) return filters;
  const mark = fingerprint(filters.data);
  const cursor = readCursor(given.cursor, mark);
  return cursor.error ? cursor : ok({ query: { owner, limit, ...filters.data, cursor: cursor.data }, mark });
}

const foldAscii = (text: string): string => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * Whether the store answered what it was asked: the owner's completed files, inside the filters, in order. A store
 * written for 0.3 ignores name, type and order and still compiles (M10-D1), so its unfiltered page is refused here
 * instead of reaching an app as if it were the filtered one. Order is seen only within a page, so a page of one file
 * cannot show it.
 */
function answersQuery(query: FilesQuery, records: readonly FileRecord[]): boolean {
  const { owner, route, name, type, order } = query;
  const folded = name === null ? null : foldAscii(name);
  return records.every((record, index) => {
    const previous = records[index - 1]?.createdAt.getTime();
    const time = record.createdAt.getTime();
    return (
      record.owner === owner &&
      record.status === "completed" &&
      (route === null || record.route === route) &&
      (folded === null || foldAscii(record.name).includes(folded)) &&
      (type === null || (type.endsWith("/") ? record.type.startsWith(type) : record.type === type)) &&
      (previous === undefined || (order === "newest" ? time <= previous : time >= previous))
    );
  });
}

export async function listFiles(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown,
): Promise<Result<FilesPage>> {
  const options = readOptions(config, given);
  if (options.error) return options;
  const { query, mark } = options.data;
  const page = await storeCall(config.logger, `list the files of ${query.owner}`, () =>
    store.list({ ...query, statuses: ["completed"] }),
  );
  if (page.error) return page;
  if (!answersQuery(query, page.data.records)) {
    config.logger.error(
      `cloudrop: the store's list answered files outside the owner, route, name, type or order asked for (owner ${query.owner}). A store written by hand must apply every option list receives.`,
    );
    return fail(new CloudropError("SERVER_ERROR", "The store listed files that do not match this listing's options."));
  }
  const cursor = page.data.cursor === null || mark === "" ? page.data.cursor : `${mark}.${page.data.cursor}`;
  return ok({ items: page.data.records, cursor });
}
