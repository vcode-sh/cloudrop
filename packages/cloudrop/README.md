# cloudrop

Direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage. Your server decides who may upload and signs
short-lived links; the browser sends the bytes straight to the bucket, with progress, retries, pause and resume after a
reload.

Pre-release: the API may change before 0.1.

```bash
npm i cloudrop    # or: bun add cloudrop, pnpm add cloudrop
```

## Quickstart

The server, in `lib/cloudrop.ts`. It reads `CLOUDROP_SECRET` and the `CLOUDROP_R2_*` credentials on the first request:

```ts
import { createCloudrop, r2, route, unauthorized } from "cloudrop";

export const cloudrop = createCloudrop({
  storage: r2({ bucket: "media" }),
  routes: {
    avatar: route(
      {
        accept: "image/*",
        maxSize: "5MB",
        authorize: async ({ request }) => {
          const user = await getUser(request); // your app's session lookup
          return user ? { userId: user.id } : unauthorized();
        },
      },
      { prefix: ({ userId }) => `users/${userId}/avatars` },
    ),
  },
});
```

Mount it. In Next.js, `app/api/cloudrop/[...all]/route.ts`:

```ts
import { toNextHandler } from "cloudrop/next";
import { cloudrop } from "../../../../lib/cloudrop";

export const { GET, POST, OPTIONS } = toNextHandler(cloudrop);
```

Upload from React. `createUploadHooks` needs only the server's type (a type import), so no server code reaches the
browser. Create the hooks once, in their own module when several components upload:

```tsx
"use client";
import { createUploadHooks } from "cloudrop/react";
import type { cloudrop } from "../lib/cloudrop";

const { useUpload } = createUploadHooks<typeof cloudrop>();

export function AvatarPicker() {
  const { files, getInputProps } = useUpload("avatar", { accept: "image/*" });
  const avatar = files.at(-1);
  return (
    <label>
      Avatar <input {...getInputProps()} />
      {avatar && `${avatar.status} ${Math.round(avatar.progress * 100)}%`}
      {avatar?.error && <p role="alert">{avatar.error.message}</p>}
    </label>
  );
}
```

Without React, `createCloudropClient` from `cloudrop/client` gives you `upload()`, which resolves to `{ data, error }`.

## Bucket setup

The browser uploads to the bucket directly, so the bucket needs a CORS rule that allows `PUT` from your page's origin
with the headers cloudrop signs (`content-type`, `content-disposition`, `if-none-match`, `x-amz-meta-cloudrop-id`) and
exposes `ETag` and `Retry-After`, plus a lifecycle rule that aborts incomplete multipart uploads. Both rules, with the
Wrangler and AWS CLI commands: [Bucket setup](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/bucket-setup.md).

## Documentation

[Server](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/server.md) ·
[Client](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/client.md) ·
[React](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/react.md) ·
[Deployment](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/deployment.md) ·
[Resume after reload](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/resume.md) ·
[Errors](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/errors.md) ·
[Troubleshooting](https://github.com/vcode-sh/cloudrop/blob/main/docs/guide/troubleshooting.md)

Runs on Node.js 24+, Bun, Deno and Cloudflare Workers, with zero runtime dependencies. `cloudrop/react` needs React 18
or 19, an optional peer dependency.

## License

[MIT](https://github.com/vcode-sh/cloudrop/blob/main/LICENSE). Not affiliated with Cloudflare.
