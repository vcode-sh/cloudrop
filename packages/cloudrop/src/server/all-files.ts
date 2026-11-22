// api.allFiles (M11-L): the files of every owner, in any status, a page at a time, for an admin inventory, a moderation
// queue or a support tool. A method of its own, so an `owner` that is undefined by a bug in a call of api.files can
// never list everyone's files. Its options, cursors and page check are api.files's (owner-files.ts).

import { configError, fail, type Result } from "../errors.ts";
import { invalidInput, optionsOf } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { badOwner, type FilesOptions, type FilesPage, isOwnerOrId, listPage } from "./owner-files.ts";
import type { CloudropStore, FileRecordStatus, RecordOf } from "./store.ts";

/** `R` is the server's route names, `S` the status asked for. */
export interface AllFilesOptions<R extends string = string, S extends FileRecordStatus = FileRecordStatus>
  extends Omit<FilesOptions<R>, "owner"> {
  /**
   * Only this owner's files, as the route's `owner` callback returned it. Left out: every owner's, and files without
   * one. Leave the key itself out for that: `owner: undefined` is refused with `INVALID_INPUT`, so a user id lost by a
   * bug never lists everyone's files.
   */
  owner?: string;
  /** Only files in this status, such as `"completed"`. Left out: every status. */
  status?: S;
  /**
   * The `cursor` an earlier page answered; null, as the last page answers, is the first page. Pass the same owner,
   * status, route, name, type and order.
   */
  cursor?: string | null;
}

const STATUSES: readonly unknown[] = [
  "pending",
  "completing",
  "completed",
  "aborted",
  "rejected",
  "failed",
  "expired",
  "deleted",
] satisfies FileRecordStatus[];

const isStatus = (status: unknown): status is FileRecordStatus => STATUSES.includes(status);

/** The page is checked to hold only the status asked for (`listPage`), so it is typed by that status, `S`. */
export async function listAllFiles<S extends FileRecordStatus>(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown,
): Promise<Result<FilesPage<RecordOf<S>>>> {
  // Anything but a function counts as missing: a store written before 0.6 has none.
  const { listAll } = store;
  if (typeof listAll !== "function") {
    return fail(
      configError(
        "api.allFiles needs the store's listAll method. Add it to your store as CloudropStore describes it; cloudrop's own stores have it.",
      ),
    );
  }
  const options = optionsOf(given);
  if (!options) {
    return fail(
      invalidInput("allFiles takes { owner, status, route, name, type, order, limit, cursor }, all optional."),
    );
  }
  const { owner, status } = options;
  // A key that is there with no value is an id that got lost on its way here, the mistake this method is kept apart
  // from api.files for: only a call without the key crosses owners (M11-R195).
  if (owner === undefined && "owner" in options) {
    return fail(
      invalidInput(
        "owner is undefined. Pass the owner's id to list that owner's files, or leave the owner key out to list every owner's files.",
      ),
    );
  }
  if (owner !== undefined && !isOwnerOrId(owner)) return badOwner();
  if (status !== undefined && !isStatus(status)) {
    return fail(invalidInput(`status must be one of ${STATUSES.join(", ")}.`));
  }
  const scope = { owner: owner ?? null, status: status ?? null };
  // Called on the store, as a store may be a class whose methods read `this`.
  return listPage(config, options, scope, "listAll", (query) => listAll.call(store, query));
}
