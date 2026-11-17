// Hooks on a cloudrop server on the in-process fake R2, for the cloudrop/react tests, and the helpers those tests share.
// Never shipped.

import type { UploadFile } from "../react/types.ts";
import { createUploadHooks } from "../react.ts";
import type { Route } from "../server/route.ts";
import { clientFixture, type Fault } from "./client-fixture.ts";
import { errorResponse } from "./fake-r2/responses.ts";
import { gate } from "./persist-fixture.ts";

/** Hooks whose client is created from options on first use, as an app's are, on a fixture answered by `fault`. */
export function hooksFixture<TRoutes extends Record<string, Route>>(routes: TRoutes, fault: Fault = () => undefined) {
  const fixture = clientFixture(routes, { fault });
  return { fixture, ...createUploadHooks({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false }) };
}

/** waitFor polls every 50 ms by default; these renders follow microtasks and 0 ms backoffs. */
export const fast = { interval: 1 };
export const note = (text: string, name: string): File => new File([text], name, { type: "text/plain" });
/** Holds the single PUT of the file of `size` bytes: sizes 5, 6 and 7 tell the files apart. */
export const holdPut = (size: number): ReturnType<typeof gate> =>
  gate((call) => call.label === "PUT object" && (call.init.body as Blob).size === size);
/** Every PUT of a file of `size` bytes fails while `failing.on`, through all its attempts: STORAGE_ERROR. */
export function failPut(size: number): { failing: { on: boolean }; fault: Fault } {
  const failing = { on: true };
  const fault: Fault = (call) =>
    failing.on && call.label === "PUT object" && (call.init.body as Blob).size === size
      ? errorResponse(500, "InternalError", "We encountered an internal error. Please try again.")
      : undefined;
  return { failing, fault };
}
/** "a.txt done", "b.txt uploading": a file reduced to its name and status. */
export const statuses = (files: readonly UploadFile<unknown>[]): string[] =>
  files.map((file) => `${file.name} ${file.status}`);
