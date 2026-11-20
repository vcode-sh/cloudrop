import { createCloudropClient } from "cloudrop/client";
import { createUploadHooks } from "cloudrop/react";
// A type import: the server, its database driver and its secrets stay out of the browser bundle.
import type { Uploads as Server } from "cloudrop-example-hono/types";
import { createContext, useCallback, useContext, useEffect } from "react";
import { API_ORIGIN } from "./api";

/** One user's upload client, which sign-out forgets (src/components/auth-panel.tsx), and the hooks over it. */
function createUploads(userId: string) {
  // The namespace keeps each user's unfinished uploads apart on a shared browser: the next user to sign in never lists
  // or resumes them, even when the last one closed the tab without signing out (docs/guide/resume.md).
  const client = createCloudropClient<Server>({ basePath: `${API_ORIGIN}/api/cloudrop`, namespace: userId });
  return { client, ...createUploadHooks<Server>({ client }) };
}

export type Uploads = ReturnType<typeof createUploads>;

const byUser = new Map<string, Uploads>();

/** The uploads of the signed-in user's id, or of `""` signed out; the same object for the same user. */
export function uploadsFor(userId: string): Uploads {
  const known = byUser.get(userId) ?? createUploads(userId);
  byUser.set(userId, known);
  return known;
}

/** Provided by src/app.tsx for the signed-in user, which remounts everything below it when the user changes. */
export const UploadsContext = createContext(uploadsFor(""));

export const useUploads = (): Uploads => useContext(UploadsContext);

/** Cancels every upload of the user's routes: sign-out calls it before forget() (src/components/auth-panel.tsx). */
export function useStopUploads(): () => void {
  const { useUpload } = useUploads();
  const stopAvatar = useUpload("avatar").abort;
  const stopAttachments = useUpload("attachments").abort;
  return useCallback(() => {
    stopAvatar();
    stopAttachments();
  }, [stopAvatar, stopAttachments]);
}

/**
 * Stops the last user's uploads when the keyed provider in src/app.tsx unmounts, as it does once this tab's session
 * hook sees a user change without a sign-out on this page (a sign-in in another tab). An upload still waiting for its
 * ticket then never asks /upload with the next user's session; one sent before this tab saw the change already did.
 */
export function StopUploadsOnUserChange(): null {
  const stop = useStopUploads();
  useEffect(() => stop, [stop]);
  return null;
}
