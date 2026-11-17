import { createUploadHooks } from "cloudrop/react";
// A type import: the server module, and the secret it reads, stay out of the browser bundle.
import type { cloudrop } from "./cloudrop";

// The client is created at the first upload in the browser, never while Next.js renders the page on the server.
export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>();
