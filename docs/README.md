# cloudrop documentation

Everything about using cloudrop, and the record of how it was built. New here? Read the
[README's quick start](../README.md#quick-start) first, then the guides in this order.

## Guides

For developers adding uploads to an app, in reading order:

1. [Server](guide/server.md): `createCloudrop`, storage drivers, routes and who may use them, the upload token,
   mounting the handler in your framework, origins, and the `cloudrop.api` file operations.
2. [Bucket setup](guide/bucket-setup.md): the CORS and lifecycle rules for R2 and S3, credentials and permissions,
   and what `checkBucket` reports. [The cloudrop command](guide/command.md) checks the settings and the bucket
   (`cloudrop doctor`) and adds the rules (`cloudrop setup`).
3. [Client](guide/client.md): `cloudrop/client` without React: uploading, progress, pause, retry, concurrency and
   offline.
4. [React](guide/react.md): `useUpload` and `useResumable`, and how to build an upload UI on them.
5. [Resume after reload](guide/resume.md): how a large upload survives a reload or a closed tab.
6. [Database store](guide/store.md): a row per upload in your database, `onComplete` once, quotas, revocation and the
   sweep.
7. [Deployment](guide/deployment.md): same-origin and cross-origin setups, cookies, proxies, building without secrets,
   Cloudflare Workers.
8. [Hono with better-auth and Drizzle](guide/hono.md): a complete app, step by step, with a Vite SPA on another origin.
9. [Testing your app](guide/testing-your-app.md): `cloudrop/testing`, your routes, store and a whole upload in your
   own tests, with no bucket, browser or network.
10. [Plugins](guide/plugins.md): `cloudrop/plugins` and `contentChecks()`, which refuses a file whose content is not the
    type it was sent as.

When something goes wrong:

- [Errors](guide/errors.md): every error code, where it comes from and what to do.
- [Troubleshooting](guide/troubleshooting.md): symptoms and their usual causes.

## Examples

- [`examples/next`](../examples/next/README.md): a Next.js app with an upload UI, against RustFS, Wrangler or R2.
- [`examples/hono`](../examples/hono/README.md) and [`examples/vite-react`](../examples/vite-react/README.md): the
  Hono API and the Vite web app of the Hono guide.

## For contributors

- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, gates, lanes and the pull request flow.
- [Testing](guide/testing.md): every test lane, what it needs, its ports, and the rules for writing tests.
- [Releasing](releasing.md): how a version is published to npm through trusted publishing (the maintainer's
  procedure).
- [AGENTS.md](../AGENTS.md): the binding rules, written for coding agents.

## Decisions

[`decisions/`](decisions/README.md) records every non-obvious choice behind the code: what was decided, why, what it
costs if it is wrong, and whether it still holds. Code comments and commits cite entries by id, such as `M3-U94`.

## Research

Measured behaviour that the code relies on, with the commands and dates:

- [R2 spike findings](research/r2-spike-findings.md): what real Cloudflare R2 does with presigned uploads, multipart,
  checksums, conditional writes and CORS. When R2's documentation and these measurements disagree, the measurement
  wins.
- [R2 platform and test backends](research/r2-platform-and-test-backends.md) and
  [test backends](research/test-backends.md): which local services stand in for R2 in tests, and where they differ.
- [Landscape and packaging](research/landscape-and-packaging.md): other upload libraries and protocols, and how
  cloudrop is packaged.
- [M3 slice measurements](research/2026-11-16-m3-slice-measurements.md): the first browser uploads end to end.

## Design and planning record

[`superpowers/`](superpowers/plans/README.md) holds the design specs and implementation plans the project was built
from, milestone by milestone. [`plans/README.md`](superpowers/plans/README.md) says where the project stands and what
comes next; the base design is [`specs/2026-11-15-cloudrop-design.md`](superpowers/specs/2026-11-15-cloudrop-design.md).
They are a working record: the guides describe the code as it is, and win where the two differ.
