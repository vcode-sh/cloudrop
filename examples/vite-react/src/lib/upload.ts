import { createCloudropClient } from "cloudrop/client";
import { createUploadHooks } from "cloudrop/react";
// A type import: the server, its database driver and its secrets stay out of the browser bundle.
import type { Uploads } from "cloudrop-example-hono/types";
import { API_ORIGIN } from "./api";

// One client for the page, created here so sign-out can call its forget() (src/components/auth-panel.tsx).
export const uploadClient = createCloudropClient<Uploads>({ basePath: `${API_ORIGIN}/api/cloudrop` });

export const { useUpload, useResumable } = createUploadHooks<Uploads>({ client: uploadClient });
