# M4a: audit fixes, developer experience and React hooks

Date: 2026-11-17. Status: done (merged to `main` 2026-11-17); approved by the owner's standing instruction ("follow the best recommendations, no quick
workarounds"), who asked on 2026-11-17 to fix the `route()` ordering trap, ship the hooks, and act on a cold-developer
test and a code audit. Decisions are recorded as `M4-F` (fixes and developer experience) and `M4-B` (bindings) in
`docs/decisions/m4-dx.md`.

## 1. Evidence this spec answers

- **Cold-developer tests** (two fresh agents, docs and tarball only): a Next.js 16 app scored 8/10 and a Hono + Vite
  React app 8.5/10. Both finished every feature first time. Friction, most severe first: no React hooks (15 to 80 lines
  of `useSyncExternalStore` wiring and guessed `UploadJob` types); no Hono recipe and no page on same-origin versus
  cross-origin deployments (cookies, `trustedOrigins`, which origin the bucket CORS lists); `s3()` reads no environment
  variables; no AWS CLI recipe for CORS and lifecycle on S3-compatible services; the npm tarball has no README or
  LICENSE; the README says nothing usable is published; re-picking the same file fires no `change` event.
- **Product fit** (app-b, app-c and a Bun + Hono + Drizzle app): the Hono app waits on cloudrop for uploads; app-b's server-routed image flows
  and 2 GB single-PUT video are good targets; app-c needs React Native and tus, out of scope. The strongest cross-project
  need is a database `store` (pending row before signing, exactly-once completion, orphan sweep) that works with Prisma
  and Drizzle: recorded for the roadmap (§7), not built here.
- **Client audit:** no corrupting race. Findings F1 to F8 and simplifications S1 to S9 (§3).
- **Server audit:** one confirmed bug (listed keys are trimmed), one plausible R2 race on overlapping completions, the
  ordering trap explained with a working fix, a lazy configuration design, simplifications (§4, §5).

## 2. Goals and non-goals

Goals: every audit finding fixed or ruled on; the ordering trap gone; `next build` without secrets; the friction above
removed; `cloudrop/react` with hooks that make a progress UI a few lines; less code where behaviour stays identical.

Non-goals (§7): the database store, React Native, a bucket-setup CLI, the example home page's upload UI and the
`examples/{hono,vite-react}` apps (M4b), per-route `Cache-Control`, more than 100 files per `/upload`.

## 3. Client fixes (`M4-F1` to `M4-F9`)

| Id | Finding | Ruling |
|---|---|---|
| F1 | A failed multipart file with persistence on gives up its ticket with `/abort` at `pagehide` (and `upload()` at once), deleting the resume record, so the reload a user makes to recover sends every byte again (`file-run.ts` `end`, `lifecycle.ts`). | Amend M3-S15, M3-U29, M3-U33: a failed **multipart** file whose record was saved gives up its ticket without `/abort` (release the lock, keep the record, as the `mayBeComplete` branch does); the bucket's lifecycle rule removes parts never resumed. Single-PUT files and `persist: false` keep today's `/abort`. `abort()` by the caller still sends `/abort`. The M3-U88 hazard (another tab completed the upload) must stay impossible: a given-up ticket sends no later `/abort` from this page. |
| F2 | A file cancelled while the job's `/upload` is in flight stays `queued` for the whole `/upload` budget, then still gets a ticket, a lock, a save and an `/abort`. | A queued file without a ticket settles `aborted` at once when cancelled; a ticket that arrives for it later gets one background `/abort` and nothing else (no lock, no save, no `PUT`). |
| F3 | Endpoint calls (`/upload`, `/complete`, `/sign`) have no timeout; a server that never answers leaves files `queued` or `completing` forever. | A per-request timeout (30 s for `/upload` and `/sign`, 120 s for `/complete`, which may list 10,000 parts) maps to a retryable `NETWORK_ERROR`, distinct from a cancel; a timed-out `/complete` sets `mayBeComplete`. |
| F4 | A cancel during `/complete` that answers `PARTS_MISSING` publishes `uploading` after the cancel. | Return before the repair when the file's cancel fired. |
| F5 | `entry.run` is assigned twice during `resume()` checks; correctness depends on microtask order. | Assign it once, to the whole resume run. |
| F6 | `AbortSignal.timeout` is wrapped in a `try/catch` that only hides a missing API, silently skipping every `/abort`. | The browser floor (ES2023 target: Chrome 103, Safari 16, Firefox 100) has it: drop the `try/catch` and its test row. |
| F7 | `probed()` checks `missing.includes(part)` per stored part: O(L×M), 20 ms at 10,000 parts. | Use a `Set`. |
| F8 | The part URL map is rebuilt on every pass; after a pause, parts signed in an earlier pass are signed again and renewed URLs fall back to the ticket's. | Keep the map on the upload. |
| F9 | Simplifications S1 to S9 (one-caller `retryJob`, `Alone` → `first?`, `classifyAnswer` parses its own inputs, dead exports `Alone`, `UploadLock`, `Step`, `PARTS_IN_FLIGHT`, `createMeter()` parameter, inline `args`, and S9: fold `refused()`'s wait into `askAlone` under one `job.watch`). | All accepted. S9 amends M3-U92: offline pauses a file waiting to re-ask `/upload` whatever the other files do. |

## 4. Server and storage fixes (`M4-F10` to `M4-F14`)

| Id | Finding | Ruling |
|---|---|---|
| F10 | `xmlText` trims, so a listed key with leading or trailing whitespace (or NBSP) comes back changed: `deletePrefix` can never delete it and fails forever. | Keys and other identifiers from storage XML are decoded without trimming. Contract rows for keys with edge whitespace on every backend. |
| F11 | A custom driver whose `presignParts` throws leaves the created multipart upload open. | `startFile` aborts the multipart upload before rethrowing. |
| F12 | Overlapping `CompleteMultipartUpload` on one upload (a `/complete` retried past a proxy timeout) may answer `NoSuchUpload` before the object is visible; the client then clears `mayBeComplete`, and a cancel can delete a recorded file (M3-U83's "If wrong"). | Measure on live R2 first (two overlapping completions, then ListParts/HEAD timing), record the result in the findings. If the window exists, "upload gone and no object" is retried once after a short delay before `NO_SUCH_UPLOAD`. |
| F13 | Simplifications: `verifyObject` does its own HEAD; `presign.ts` uses the shared `allOk`; request bodies read through `new Blob(chunks).arrayBuffer()` in `http.ts` and `node.ts`; one `abortContexts` helper for the three hand-built abort contexts. | Accepted. |
| F14 | Size budgets measure unminified server entries. | Add a bundled-and-minified budget for `cloudrop` (what Workers ship) beside the summed one. |

## 5. API and developer experience (`M4-F15` to `M4-F21`)

### 5.1 `route(policy, callbacks?)` (`M4-F15`, amends M2-X6)

TypeScript infers type arguments from context-sensitive callbacks left to right inside one object literal, so a
`prefix`, `key` or `onComplete` written before `authorize` fixes `TAuth` at `object`. `NoInfer`, inferring the whole
`authorize` and wrapper helpers were tried on tsc 7.0.2 and do not fix it. Two arguments do:

```ts
route(
  { accept: "image/*", maxSize: "5MB", metadata: schema, authorize: async ({ request, metadata }) => ({ userId }) },
  { prefix: ({ userId }) => `users/${userId}`, onComplete: ({ file, userId }) => ({ key: file.key }) },
);
```

The first argument holds every option that is not typed from `authorize`'s result (`accept`, `maxSize`, `maxFiles`,
`metadata`, `visibility`, `authorize`); the second, optional, holds `prefix`, `key` and `onComplete`. Inside each
object any order compiles. The single-object form is removed (pre-1.0; no compatibility shim). A type test proves the
options compile in every order that used to fail. Every route in the repository, examples and docs moves to the new
form.

### 5.2 Lazy environment configuration (`M4-F16`, amends M3-H14)

Values read from the environment (`CLOUDROP_SECRET`, the storage presets' credentials, account, endpoint and bucket)
resolve on the first request, not at `createCloudrop()`. Checks that need no environment value stay eager, and so does
every explicitly passed value. With `NODE_ENV=development` the environment is also checked eagerly, so `next dev` still
fails at start. A value still missing at request time logs `INVALID_CONFIG` once and answers `SERVER_ERROR` 500 to
every request until fixed; `cloudrop.api` calls answer the same error. `next build` then needs no secret.

### 5.3 Storage presets read the environment (`M4-F17`)

`s3()` reads `CLOUDROP_S3_ENDPOINT`, `CLOUDROP_S3_REGION`, `CLOUDROP_S3_BUCKET`, `CLOUDROP_S3_ACCESS_KEY_ID` and
`CLOUDROP_S3_SECRET_ACCESS_KEY`; `r2()` also reads `CLOUDROP_R2_BUCKET`. `r2()` and `s3()` with no argument then work.
A missing value is reported by name, all at once, as today for `r2()`.

### 5.4 `forbidden()` (`M4-F18`)

A refusal for a signed-in user who may not upload (quota, plan, role): `forbidden(message?)` from `cloudrop`, usable
wherever `unauthorized()` is, answering `403 FORBIDDEN`, not retryable. The docs stop using `UNAUTHORIZED` for quota.

### 5.5 Package README and LICENSE (`M4-F19`)

`packages/cloudrop/README.md` (short: what it is, install, a five-line quickstart, links to the docs) and `LICENSE`
ship in the tarball; `package:check` fails when either is missing.

### 5.6 Documentation (`M4-F20`)

- README: an install line (`bun add cloudrop` / `npm i cloudrop`), status worded as "pre-release; the API may change
  before 0.1" without "nothing usable".
- `docs/guide/server.md`: Hono and Bun recipes (`app.all("/api/cloudrop/*", (c) => cloudrop.handler(c.req.raw))`, the
  handler answers its own preflight so no CORS middleware on that path); better-auth in `authorize`
  (`auth.api.getSession({ headers: request.headers })`); reading a cookie from a raw `Request`.
- New `docs/guide/deployment.md`: same-origin (proxy or one app) versus cross-origin API (absolute `basePath`,
  `trustedOrigins`, cookies `SameSite=None; Secure` across sites), and that the bucket CORS lists the page's origin.
- `docs/guide/bucket-setup.md`: AWS CLI with `--endpoint-url` for CORS and lifecycle on any S3-compatible service,
  with the lifecycle JSON.
- `docs/guide/client.md`: custom `fetch` for bearer-token auth (native apps, QR sessions); resetting a file input.
- `docs/guide/react.md` for §6.

### 5.7 Not changed

Client bundle ceiling 11 kB stays for `cloudrop/client`; §3 aims to fit it through its own simplifications. If the fixes
cannot fit after every gated simplification, the ceiling rises to 11.5 kB with a decision entry (the M3-U91 headroom rule).

## 6. `cloudrop/react` (`M4-B1` to `M4-B6`)

### 6.1 Shape

```ts
// lib/upload.ts
import { createUploadHooks } from "cloudrop/react";
import type { cloudrop } from "./cloudrop";
export const { useUpload, useResumable } = createUploadHooks<typeof cloudrop>(); // client options, or { client }

// a component
const { files, totals, isUploading, getInputProps, getDropProps, isDragOver, upload, pause, resume, abort, retry, clear } =
  useUpload("documents", { metadata: { folderId }, multiple: true });
return (
  <div {...getDropProps()}>
    <input type="file" {...getInputProps()} />
    {files.map((f) => <Row key={f.id} name={f.name} progress={f.progress} onPause={f.pause} onRetry={f.retry} />)}
  </div>
);
```

- **`createUploadHooks<typeof cloudrop>(options?)` (`M4-B1`).** A factory, so the route name, metadata and result are
  inferred from the first argument of `useUpload` without a second type argument. Options are
  `createCloudropClient`'s, or `{ client }` to share one. The client is created on first use in the browser, never
  during server rendering.
- **`useUpload(route, options?)` (`M4-B2`).** Options: `metadata` (required when the route's schema requires it, typed
  per route), `multiple`, `accept` (the input's `accept` attribute; advisory, the server decides). Returns:
  - `files`: every file of the jobs this hook started, in start order; each is the client's file snapshot plus bound
    `pause`, `resume`, `abort` and `retry`. Objects keep their identity until that file changes.
  - `totals` and `isUploading` across those jobs.
  - `upload(files, { metadata? })`: starts a job and resolves to its `UploadResult`; accepts a `File`, an array, a
    `FileList` or `null` (null or empty resolves `null` and starts nothing).
  - `getInputProps()`: `type`, `multiple`, `accept` and an `onChange` that uploads and resets the input's value, so
    picking the same file again works.
  - `getDropProps()` and `isDragOver`: drag-and-drop on any element.
  - `pause`, `resume`, `abort`, `retry` for every file of the hook; `clear()` drops settled jobs from `files`.
  - `resume(upload, file)`: resumes a record from `useResumable` into this hook's `files`.
- **`useResumable(route?)` (`M4-B3`).** `{ uploads, refresh }`: the client's `resumable()` list, read after mount and
  after every job of the client settles; `uploads` is `[]` on the server and before the first read.
- **Behaviour (`M4-B4`).** Built on `useSyncExternalStore` with a constant server snapshot; StrictMode-safe (no
  upload starts in an effect); unmounting unsubscribes and does not abort (the client owns the jobs, and their resume
  records stay); React 18 and 19, `react` an optional peer dependency.
- **Size (`M4-B5`).** `cloudrop/react` ≤ 1.5 kB gzip bundled without `cloudrop/client` and `react`, with its own
  size-limit entry.
- **Tests (`M4-B6`).** Unit tests with React Testing Library on happy-dom for the hook contract (identity, totals,
  input reset, drop, StrictMode, unmount, SSR snapshot); the example app's home page moves to the hooks and the
  browser lane proves them in Chromium.

## 7. Recorded for the roadmap, not built here

1. **Database `store` interface** (pending row before signing, exactly-once `onComplete`, orphan sweep, quota) usable
   from Prisma and Drizzle: recommended to move ahead of the M5 plugins; owner decision.
2. **M4b:** the Next example's home page as a real upload UI on the hooks, `examples/hono` and `examples/vite-react` (the
   cold-developer apps are a starting point). No shadcn registry: the hooks stay headless and the examples show how to
   build the UI (`M4-E1`, 2026-11-17).
3. A bucket-setup command for R2 and S3-compatible services.
4. React Native client with background transfer (app-c); per-route `Cache-Control`; batches over 100 files.

## 8. Work breakdown and gates

| Task | Owns | Depends on |
|---|---|---|
| A. Client fixes F1–F9 | `src/client/**`, `docs/decisions/m4-dx.md` (client rows) | none |
| B. Server fixes F10–F14 incl. the live R2 probe | `src/storage/**`, `src/server/{complete,presign,upload,http,plugins,token-request}.ts`, `src/node.ts`, `scripts/size-limit.config.ts` | none |
| C. API: `route(policy, callbacks)`, lazy env, presets env, `forbidden()` | `src/server/{route,route-config,config,cloudrop,api}.ts`, `src/storage/presets.ts`, `src/env.ts`, every `route(` call site | B merged |
| D. `cloudrop/react` | `src/react/**`, `src/react.ts`, package exports, tsdown, size-limit entry, example home page | A merged |
| E. Package README/LICENSE and docs | `packages/cloudrop/README.md`, `LICENSE`, `scripts/check-package.sh`, `README.md`, `docs/guide/**`, `examples/next/README.md` | C, D merged |

Every task: TDD per `testing-patterns`, `code-quality` review, decision entries in the same change, `bun run verify`;
A and D add `test:chaos` and `test:browser`; B and C add `test:rustfs`, `test:wrangler`, `test:live`, `test:chaos`.
The branch closes with every lane green, a whole-branch review, fast-forward to `main` and a push.
