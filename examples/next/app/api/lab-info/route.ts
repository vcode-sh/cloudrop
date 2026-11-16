import { displayHost } from "../../lab/host";

type StorageName = "RustFS" | "Wrangler" | "R2";

export interface LabInfo {
  storage: StorageName;
  host: string;
}

/**
 * Demo only: tells the lab page which storage lib/cloudrop.ts uploads to, by name and host, never a credential or the
 * bucket's name. A real app has no reason to tell visitors where it stores files.
 */
export function GET(): Response {
  // Read as lib/cloudrop.ts reads it: an empty CLOUDROP_S3_ENDPOINT means R2.
  const endpoint = process.env.CLOUDROP_S3_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    // Wrangler serves its local R2 under this path (README.md, "Run with Wrangler").
    const storage: StorageName = url.pathname.startsWith("/cdn-cgi/local/r2") ? "Wrangler" : "RustFS";
    return Response.json({ storage, host: url.host } satisfies LabInfo);
  }
  const account = process.env.CLOUDROP_R2_ACCOUNT_ID ?? "";
  return Response.json({
    storage: "R2",
    host: displayHost(`${account}.r2.cloudflarestorage.com`),
  } satisfies LabInfo);
}
