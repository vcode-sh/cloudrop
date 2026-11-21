// api.allFiles (M11-L): the files of every owner, in any status, a page at a time, for an admin inventory, a moderation
// queue or a support tool. A method of its own, so an `owner` that is undefined by a bug in a call of api.files can
// never list everyone's files. Its options, cursors and page check are api.files's (owner-files.ts).

import { configError, fail, type Result } from "../errors.ts";
import { invalidInput, isPlainObject } from "../input.ts";
import type { ServerConfig } from "./config.ts";
import { badOwner, type FilesOptions, type FilesPage, isOwnerOrId, listPage } from "./owner-files.ts";
import type { CloudropStore, FileStatus } from "./store.ts";

export interface AllFilesOptions extends Omit<FilesOptions, "owner"> {
  /** Only this owner's files, as the route's `owner` callback returned it. Left out: every owner's, and files without one. */
  owner?: string;
  /** Only files in this status, such as `"completed"`. Left out: every status. */
  status?: FileStatus;
  /** The `cursor` an earlier page answered. Pass the same owner, status, route, name, type and order. */
  cursor?: string;
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
] satisfies FileStatus[];

const isStatus = (status: unknown): status is FileStatus => STATUSES.includes(status);

export async function listAllFiles(
  config: ServerConfig,
  store: CloudropStore<unknown>,
  given: unknown = {},
): Promise<Result<FilesPage>> {
  // Anything but a function counts as missing: a store written before 0.6 has none.
  const { listAll } = store;
  if (typeof listAll !== "function") {
    return fail(
      configError(
        "api.allFiles needs the store's listAll method. Add it to your store as CloudropStore describes it; cloudrop's own stores have it.",
      ),
    );
  }
  if (!isPlainObject(given)) {
    return fail(
      invalidInput("allFiles takes { owner, status, route, name, type, order, limit, cursor }, all optional."),
    );
  }
  const { owner, status } = given;
  if (owner !== undefined && !isOwnerOrId(owner)) return badOwner();
  if (status !== undefined && !isStatus(status)) {
    return fail(invalidInput(`status must be one of ${STATUSES.join(", ")}.`));
  }
  const scope = { owner: owner ?? null, status: status ?? null };
  // Called on the store, as a store may be a class whose methods read `this`.
  return listPage(config, given, scope, "listAll", (query) => listAll.call(store, query));
}
