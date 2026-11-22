// api.files (M8-A1, M10-D1, M10-D2): an owner's completed files, newest or oldest first, optionally filtered by route,
// name and type, a page at a time, straight from the store's rows. api.allFiles (all-files.ts) reads its options, its
// cursors and the store's page through the same code (M11-L).

import { CloudropError, fail, ok, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { type FileFilters, readFilters } from "./files-filters.ts";
import type { CloudropStore, CompletedRecord, FileRecord, FileStatus } from "./store.ts";
import { storeCall } from "./store-calls.ts";

/** `R` is the server's route names. */
export interface FilesOptions<R extends string = string> {
  /** The owner, as the route's `owner` callback returned it. */
  owner: string;
  /** Only this route's files. */
  route?: R;
  /** Only files whose name contains this, ASCII letters in either case: `"report"` finds `"Q3 Report.pdf"`. */
  name?: string;
  /** Only this type, such as `"application/pdf"`, or every type under a top-level type, such as `"image/"`. */
  type?: string;
  /** `"newest"` upload first (the default) or `"oldest"`. */
  order?: "newest" | "oldest";
  /** Files per page, 1 to 1000. Default 100. */
  limit?: number;
  /**
   * The `cursor` an earlier page answered, to read the next one; null, as the last page answers, is the first page.
   * Pass the same route, name, type and order.
   */
  cursor?: string | null;
}

/** A page of `TRecord`s: `CompletedRecord`s from `api.files`, the status asked for from `api.allFiles`. */
export interface FilesPage<TRecord extends FileRecord = FileRecord> {
  /** The files' rows, in the order asked for. */
  items: TRecord[];
  /** Pass it back to read the next page; null on the last one. */
  cursor: string | null;
}

/** The last time an ISO string without a sign names, which is how Postgres is given a time: 9999-12-31T23:59:59.999Z. */
const LAST_TIME_MS = 253_402_300_799_999;
/** A cursor that carries its listing's mark: the mark, a dot, then the store's cursor. */
const MARKED_CURSOR = /^(?:((?:all\.)?[0-9a-f]{8})\.)?(.*)$/s;

/** The listing the store is asked for, every option checked. `api.allFiles` may leave the owner and the status null. */
interface FilesQuery extends FileFilters {
  owner: string | null;
  status: FileStatus | null;
  limit: number;
  cursor: string | null;
}

/** The longest owner or file id, in characters. */
export const MAX_OWNER_LENGTH = 255;

/**
 * An owner or a file id: 1 to 255 characters, none of them NUL or a lone surrogate. Postgres text cannot hold U+0000,
 * so no row has one, and the store would fail on it: refused here, it is the caller's mistake and not a retryable
 * SERVER_ERROR. A lone surrogate is stored as U+FFFD, by Postgres's drivers and by SQLite, so two owners that differ
 * only in one would be one owner in the database, with one quota (M11-R60).
 */
export const isOwnerOrId = (value: unknown): value is string =>
  typeof value === "string" &&
  value !== "" &&
  value.length <= MAX_OWNER_LENGTH &&
  !value.includes("\u0000") &&
  value.isWellFormed();

export const badOwner = (): Result<never> =>
  fail(
    invalidInput(
      `Pass the owner, a string of 1 to ${MAX_OWNER_LENGTH} characters without NUL (U+0000) or a lone surrogate, as owner() returned it.`,
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

/** The `limit` of a listing or a sweep: rows per page, a whole number from 1 to 1000, and 100 when left out. */
export function readLimit(limit: unknown = 100): Result<number> {
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 1000) return ok(limit);
  return fail(invalidInput("limit must be a whole number from 1 to 1000."));
}

/** FNV-1a of the options' JSON, as eight hex digits. */
function fingerprint(options: readonly unknown[]): string {
  const text = JSON.stringify(options);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Which listing a cursor belongs to, so a cursor passed with other options is refused instead of paging a listing it
 * was not made for. `api.files`: the fingerprint of its route, name, type and order, and none for the default listing,
 * whose cursors stay the plain store cursors of 0.3. `api.allFiles`: `all.` and the fingerprint of every option, the
 * owner and status included. No mark of one is ever a mark of the other, whatever the options (M11-L3).
 */
function markOf({ owner, status, route, name, type, order }: Omit<FilesQuery, "limit" | "cursor">, all: boolean) {
  if (all) return `all.${fingerprint([owner, status, route, name, type, order])}`;
  if (route === null && name === null && type === null && order === "newest") return "";
  return fingerprint([route, name, type, order]);
}

/** The store's cursor inside the caller's, refused when it is malformed or belongs to another listing than `mark`'s. */
function readCursor(cursor: unknown, mark: string): Result<string | null> {
  if (cursor == null) return ok(null);
  const [, given = "", position = ""] = (typeof cursor === "string" && MARKED_CURSOR.exec(cursor)) || [];
  if (!isStoreCursor(position)) {
    return fail(invalidInput("cursor must be one an earlier page of files returned. Leave it out for the first page."));
  }
  if (given !== mark) {
    return fail(
      invalidInput(
        `cursor belongs to a listing with another ${mark.startsWith("all.") ? "owner, status, " : ""}route, name, type or order. Pass the options of the page that returned it, or leave cursor out to start again.`,
      ),
    );
  }
  return ok(position);
}

/** The listing the store is asked for, and the mark its cursors carry. `scope` is the owner and status, already read. */
function readOptions(
  config: ServerConfig,
  given: Record<string, unknown>,
  scope: Pick<FilesQuery, "owner" | "status">,
  all: boolean,
): Result<{ query: FilesQuery; mark: string }> {
  const limit = readLimit(given.limit);
  if (limit.error) return limit;
  const filters = readFilters(config, given);
  if (filters.error) return filters;
  const mark = markOf({ ...scope, ...filters.data }, all);
  const cursor = readCursor(given.cursor, mark);
  if (cursor.error) return cursor;
  return ok({ query: { ...scope, limit: limit.data, ...filters.data, cursor: cursor.data }, mark });
}

const foldAscii = (text: string): string => text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * Whether the store answered what it was asked: files of the owner and in the status, when the listing names them,
 * inside the filters, in order. A store written for 0.3 ignores name, type and order and still compiles (M10-D1), so
 * its unfiltered page is refused here instead of reaching an app as if it were the filtered one. Order is seen only
 * within a page, so a page of one file cannot show it.
 */
function answersQuery(query: FilesQuery, records: readonly FileRecord[]): boolean {
  const { owner, status, route, name, type, order } = query;
  const folded = name === null ? null : foldAscii(name);
  return records.every((record, index) => {
    const previous = records[index - 1]?.createdAt.getTime();
    const time = record.createdAt.getTime();
    return (
      (owner === null || record.owner === owner) &&
      (status === null || record.status === status) &&
      (route === null || record.route === route) &&
      (folded === null || foldAscii(record.name).includes(folded)) &&
      (type === null || (type.endsWith("/") ? record.type.startsWith(type) : record.type === type)) &&
      (previous === undefined || (order === "newest" ? time <= previous : time >= previous))
    );
  });
}

/**
 * One page of a listing: its options read, the store asked through `read` (its `method`), and the answer checked
 * (M10-D11) before it reaches the caller.
 */
export async function listPage<TRecord extends FileRecord>(
  config: ServerConfig,
  given: Record<string, unknown>,
  scope: Pick<FilesQuery, "owner" | "status">,
  method: "list" | "listAll",
  read: (query: FilesQuery) => Promise<{ records: FileRecord[]; cursor: string | null }>,
): Promise<Result<FilesPage<TRecord>>> {
  const options = readOptions(config, given, scope, method === "listAll");
  if (options.error) return options;
  const { query, mark } = options.data;
  const whose = query.owner === null ? "every owner" : `owner ${query.owner}`;
  const page = await storeCall(config.logger, `list the files of ${whose}`, () => read(query));
  if (page.error) return page;
  if (!answersQuery(query, page.data.records)) {
    config.logger.error(
      `cloudrop: the store's ${method} answered files outside the owner, status, route, name, type or order asked for (${whose}). A store written by hand must apply every option ${method} receives.`,
    );
    return fail(new CloudropError("SERVER_ERROR", "The store listed files that do not match this listing's options."));
  }
  const cursor = page.data.cursor === null || mark === "" ? page.data.cursor : `${mark}.${page.data.cursor}`;
  // answersQuery proved every record is in the status asked for, the one `TRecord` names.
  return ok({ items: page.data.records as TRecord[], cursor });
}

export async function listFiles(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown,
): Promise<Result<FilesPage<CompletedRecord>>> {
  if (!isPlainObject(given)) {
    return fail(invalidInput("files takes { owner }, and optionally route, name, type, order, limit and cursor."));
  }
  const { owner } = given;
  if (!isOwnerOrId(owner)) return badOwner();
  return listPage(config, given, { owner, status: "completed" }, "list", ({ status: _status, ...query }) =>
    store.list({ ...query, owner, statuses: ["completed"] }),
  );
}
