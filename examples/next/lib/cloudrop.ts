import { createCloudrop, r2, route, s3, unauthorized } from "cloudrop";

// An empty CLOUDROP_S3_ENDPOINT counts as unset, so the live run can switch a RustFS .env.local back to R2.
const endpoint = process.env.CLOUDROP_S3_ENDPOINT;
// Exported for the browser test, which reads the uploads back through the same storage.
export const storage = endpoint
  ? s3({
      endpoint,
      region: process.env.CLOUDROP_S3_REGION ?? "us-east-1",
      bucket: process.env.CLOUDROP_S3_BUCKET ?? "",
      accessKeyId: process.env.CLOUDROP_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.CLOUDROP_S3_SECRET_ACCESS_KEY ?? "",
    })
  : r2({ bucket: process.env.CLOUDROP_R2_BUCKET ?? "" });

/** Demo only: the page sets this cookie. A real app reads its session here. */
const demoUser = (request: Request): string | undefined =>
  /(?:^|;\s*)demo-user=([a-z0-9-]{1,32})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];

// Created when the module loads, as the quickstart shows: `next build` loads it too, so the build needs the storage
// settings and CLOUDROP_SECRET (see README.md).
export const cloudrop = createCloudrop({
  storage,
  // Small enough that the page's 20 MiB test file goes in three parts; the default is 64 MiB.
  multipartThreshold: "8MB",
  routes: {
    files: route({
      accept: ["text/plain", "application/octet-stream", "image/*"],
      maxSize: "100MB",
      authorize: ({ request }) => {
        const userId = demoUser(request);
        return userId ? { userId } : unauthorized("Sign in as the demo user first.");
      },
      prefix: ({ userId }) => `${process.env.CLOUDROP_EXAMPLE_PREFIX ?? "example"}/${userId}`,
      onComplete: ({ file }) => ({ key: file.key }),
    }),
  },
});
