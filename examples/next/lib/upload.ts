import { createCloudropClient } from "cloudrop/client";
import { createUploadHooks } from "cloudrop/react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "./cloudrop";

// Imported only from "use client" modules: a Server Component that imports it pulls cloudrop/react into the server
// graph, where React has no useState or useSyncExternalStore, and the build fails. Creating the client sends nothing
// and touches no storage: it looks for IndexedDB and Web Locks, and the first request waits for the first upload.
// Shared with the hooks so that the unfinished-uploads panel can call client.forget(), which the hooks do not offer.
export const client = createCloudropClient<typeof cloudrop>();
export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>({ client });
