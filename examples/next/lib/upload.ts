import { createUploadHooks } from "cloudrop/react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "./cloudrop";

// Imported only from "use client" modules: a Server Component that imports it pulls cloudrop/react into the server
// graph, where React has no useState or useSyncExternalStore, and the build fails. The client is created at the first
// upload or resumable read in the browser, never while Next.js renders the page on the server.
export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>();
