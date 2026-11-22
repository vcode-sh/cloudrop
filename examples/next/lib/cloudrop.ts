import { createCloudrop, type RouteName, r2, route, type StoreFileApi, s3, unauthorized } from "cloudrop";
import { quotaBytes, recordUpload, store } from "./store";

// The presets read their settings from CLOUDROP_S3_* or CLOUDROP_R2_* (README.md). An empty CLOUDROP_S3_ENDPOINT
// counts as unset, so the live run can switch a RustFS .env.local back to R2.
// Exported for the browser test, which reads the uploads back through the same storage.
export const storage = process.env.CLOUDROP_S3_ENDPOINT ? s3() : r2();

/**
 * Demo only, never ship this: any visitor can set this cookie to any name and upload under that user's prefix.
 * app/api/demo-sign-in/route.ts sets it. A real app reads its own signed session here.
 */
export const demoUser = (request: Request): string | undefined =>
  /(?:^|;\s*)demo-user=([a-z0-9-]{1,32})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];

// Created when the module loads, as the quickstart shows. `next build` loads it too, and needs no settings: cloudrop
// reads CLOUDROP_SECRET and the storage variables on the first request.
export const cloudrop = createCloudrop({
  storage,
  // Small enough that the page's 20 MiB test file goes in three parts; the default is 64 MiB.
  multipartThreshold: "8MB",
  // With CLOUDROP_EXAMPLE_STORE set (lib/store.ts): a row per upload, one onComplete per file, and a quota per user.
  ...(store && { store, quota: () => quotaBytes }),
  routes: {
    files: route(
      {
        // Wide enough for the lab's own files (video, audio, PDF); anything else gets FILE_TYPE_NOT_ALLOWED.
        accept: ["text/plain", "application/octet-stream", "application/pdf", "image/*", "video/*", "audio/*"],
        // At most 13 parts of 8 MiB, so the /upload ticket signs every part (a ticket signs up to 20); the lab page
        // relies on that to tell a renewal from a first /sign (app/lab/run-report.ts).
        maxSize: "100MB",
        authorize: ({ request }) => {
          const userId = demoUser(request);
          return userId ? { userId } : unauthorized("Sign in as the demo user first.");
        },
      },
      {
        prefix: ({ userId }) => `${process.env.CLOUDROP_EXAMPLE_PREFIX ?? "example"}/${userId}`,
        onComplete: ({ file, userId }) => {
          recordUpload(userId, file);
          return { key: file.key };
        },
        // Store only: createCloudrop refuses them without one. The user's uploads count toward their quota.
        owner: store ? ({ userId }) => userId : undefined,
        // After the completion is recorded, at most once: a place for emails and webhooks, never for the record.
        afterComplete: store
          ? ({ file, userId }) => console.info(`cloudrop example: ${userId} completed ${file.key}`)
          : undefined,
      },
    ),
  },
});

/**
 * `cloudrop.api` with the store's calls, or null when the example is stateless. The store is opt-in here, so the type
 * of `cloudrop.api` has none of them (M12-T3); an app that always passes a store needs no such view.
 */
export const storeApi = store ? (cloudrop.api as StoreFileApi<RouteName<typeof cloudrop>>) : null;
