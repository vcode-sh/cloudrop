import { createCloudropClient } from "cloudrop/client";
import { createUploadHooks } from "cloudrop/react";
// A type import: the server, its database driver and its secrets stay out of the browser bundle.
import type { Uploads as Server } from "cloudrop-example-hono/types";
import { createContext, useContext, useEffect } from "react";
import { API_ORIGIN } from "./api";

/** One user's upload client, which sign-out forgets (src/components/auth-panel.tsx), and the hooks over it. */
function createUploads(userId: string) {
  // The account is what the API's routes return as owner, so the API refuses an /upload this page sends after another
  // tab signed in as someone else, which would otherwise make the file theirs (docs/guide/client.md). It is also the
  // namespace that keeps each user's unfinished uploads apart on a shared browser: the next user to sign in never lists
  // or resumes them, even when the last one closed the tab without signing out (docs/guide/resume.md).
  const client = createCloudropClient<Server>({ basePath: `${API_ORIGIN}/api/cloudrop`, account: userId });
  return { client, ...createUploadHooks<Server>({ client }) };
}

export type Uploads = ReturnType<typeof createUploads>;

const byUser = new Map<string, Uploads>();

/**
 * The uploads of the signed-in user's id, or of `""` signed out; in a browser, the same object for the same user.
 * Outside one nothing is kept: this app renders in the browser only, but copied into an app that also renders on a
 * server, a cached client would stay there for good, one per user, since no effect runs on a server to close it.
 */
export function uploadsFor(userId: string): Uploads {
  if (typeof window === "undefined") return createUploads(userId);
  const known = byUser.get(userId) ?? createUploads(userId);
  byUser.set(userId, known);
  return known;
}

/** Provided by src/app.tsx for the signed-in user, which remounts everything below it when the user changes. */
export const UploadsContext = createContext(uploadsFor(""));

export const useUploads = (): Uploads => useContext(UploadsContext);

/**
 * Closes every other user's client once the page shows `userId`, as after a sign-in in another tab, which this tab's
 * session hook sees later: an upload still waiting for its ticket then never asks /upload with the new user's session,
 * and each unfinished multipart upload keeps its record for its user's next sign-in. A closed client stays closed, so
 * it is dropped, and that user's next sign-in in this page gets a new one. Run again by StrictMode, it finds nothing.
 */
export function useCloseOtherUsers(userId: string): void {
  useEffect(() => {
    for (const [id, uploads] of byUser) {
      if (id === userId) continue;
      uploads.close();
      byUser.delete(id);
    }
  }, [userId]);
}
