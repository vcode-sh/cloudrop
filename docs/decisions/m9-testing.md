# M9-T: `cloudrop/testing`

Rulings for the public test entry designed in `docs/superpowers/specs/2026-11-21-testing-and-cli-design.md` §1.
Entries continue from `M9-T1`.

### M9-T1: the entry exports three functions and four types

- **Decision:** `cloudrop/testing` exports `testBucket(options?)`, `testClient(cloudrop, options)` and
  `memoryStore(options?)`, with the types `TestBucket`, `TestBucketOptions`, `TestObject` and `TestClientOptions`, the
  design's names. Nothing else: the internal fixtures (`server-fixture.ts`, `client-fixture.ts`, `store-fixture.ts`,
  the fake R2's request helpers, the memory store's raw tables and injected failures) stay unexported, and the entry
  is the only module that turns them into public API (`src/testing.ts`).
- **Why:** each export is a semver promise. These three cover the design's cases (`authorize`, metadata, quota,
  `onComplete`, multipart) and the types a test annotates with; the fixtures are shaped for the repository's own
  assertions (request labels, store call logs) and would freeze them.
- **If wrong:** an app that needs more (planting an object, injecting a fault) asks for it, and it is added as new API.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`, `packages/cloudrop/package.json` (`exports["./testing"]`),
  `docs/guide/testing-your-app.md`.

### M9-T2: a build of its own that imports `cloudrop` and `cloudrop/client`; a 16 kB budget

- **Decision:** `tsdown.config.ts` builds the library's entries as before and `cloudrop/testing` in a second
  configuration. A small plugin there turns every import of `src/index.ts` and `src/client.ts` into an import of
  `./index.js` and `./client.js`, in the JavaScript and in the declarations, so `dist/testing.js` uses the published
  entries as an app does and carries only the fake bucket (with the signer, XML and checksum code it needs) and the
  memory store. Its size-limit budget counts its own file only: 16 kB gzip, measured at 12.71 kB.
- **Why:** built with the other entries, the shared modules move into chunks: tried on 2026-11-21, `dist/index.js` fell
  from 135,530 to 90,610 bytes and a 45,721-byte `presets-*.js` chunk appeared, so every server bundle would have
  changed. Built apart, every existing file in `dist/` keeps its size (all 16 compared) and every size-limit number is
  unchanged. Importing the published entries also keeps one `CloudropError` class, so `error instanceof CloudropError`
  holds for errors from the test client. The memory store's `store.route` cannot import `routeFor` without a second
  copy of `src/errors.ts`; it brands routes over the public `route()` with the same `Symbol.for("cloudrop.store")` that
  lets copies of cloudrop recognise each other (M9-T7). `index.js` and `client.js` are budgeted already, and only an
  app's tests load this entry.
- **If wrong:** a module the entry needs at run time that is not in `cloudrop` or `cloudrop/client` is copied into
  `testing.js`; a copied class would break `instanceof` across the two. The bundle shows each copied module under a
  `// src/...` comment.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/tsdown.config.ts`, `scripts/size-limit.config.ts`.

### M9-T3: `testBucket()` is the fake R2 behind `r2()`, inspected synchronously

- **Decision:** `testBucket()` creates the fake R2 of `src/testing/fake-r2.ts` with fixed test credentials and the
  bucket name `uploads`, and returns `storage` (`r2()` pointed at it), `fetch`, and three reads that return values,
  not promises: `object(key)` (a `TestObject` or null), `keys()` (sorted) and `pendingUploads()`. `TestObject` has
  `key`, `size`, `type`, `disposition`, `metadata` (the `x-amz-meta-*` headers without the prefix), `parts` (null for a
  single `PUT`), `body` (a copy) and `uploadedAt`. Options: `publicUrl`, and `cors` and `lifecycle` (M9-T6). The
  design's optional clock is left out: the bucket reads the global clock, as the server does.
- **Why:** the bucket is in memory, so a promise adds nothing, and `await bucket.object(key)` from the design still
  works. `parts` lets a test check that a large file went multipart. A clock of the bucket's own would only make it
  disagree with the server's signatures; `vi.useFakeTimers({ toFake: ["Date"] })` moves both, which a test proves.
- **If wrong:** a future bucket that is not in memory needs async reads, a breaking change before 1.0.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`, `packages/cloudrop/src/testing/fake-r2.ts` (`object`, `keys`).

### M9-T4: the test client is a same-origin page on `http://localhost`

- **Decision:** `testClient(cloudrop, { bucket, headers?, basePath? })` creates the real client with `basePath`
  `http://localhost<basePath>` and a `fetch` that sends requests under it to `cloudrop.handler` with
  `Origin: http://localhost` set last, and every other request to `bucket.fetch`. `basePath` must be a path without a
  trailing slash (default `/api/cloudrop`) and must match the server's. `headers` is the client's own option, so it
  reaches the server and never the bucket. A missing bucket or a non-path `basePath` throws `INVALID_CONFIG`.
- **Why:** a browser sets `Origin` on every `POST` and a page cannot change it; the handler's origin check then passes
  as for a same-origin page without `trustedOrigins`. A cross-origin page is the deployment's concern and needs a
  second origin the in-process client does not have. Cookies are modelled by `headers`, which is what the design asks.
- **If wrong:** an app that serves the API from another origin cannot test its `trustedOrigins` here; it would need an
  origin option. The app's own mounting (route file, framework adapter, body-parsing middleware) does not run either;
  the guide lists both among the differences.
- **Status:** amended by `M9-H105` (testing through the app's own mount is supported).
- **Visible in:** `packages/cloudrop/src/testing.ts`, `docs/guide/testing-your-app.md`.

### M9-T5: bucket `PUT`s through `fetch`, no persistence, no modelled cancellation

- **Decision:** the test client passes its `fetch` option, so bucket `PUT`s never use `XMLHttpRequest` (`M3-U6`), and
  `persist: false`, so nothing is written to IndexedDB. Cancellation is left to the client: a request already handed to
  the handler or the bucket finishes in-process.
- **Why:** in jsdom or happy-dom the client would otherwise reach for their `XMLHttpRequest`, which cannot reach the
  in-process bucket. The `fetch` option is also what routes requests in-process, so every test of the entry runs
  through it. With a fake IndexedDB in a test setup, persisting would carry one
  test's unfinished upload into the next; a test proves `resumable()` stays empty. A `fetch` that rejects once its
  signal fires was tried: no test of the entry, including a cancel during `/complete`, answered differently, because
  the client itself decides what a cancelled file becomes, so it was removed.
- **If wrong:** progress in tests moves a part at a time; an app asserting byte-by-byte progress cannot do it here.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`, `docs/guide/testing-your-app.md` ("What differs from a browser
  and a real bucket").

### M9-T6: bucket CORS and lifecycle as S3 XML

- **Decision:** `testBucket({ cors, lifecycle })` takes each configuration as the XML a real bucket serves, for tests
  of `cloudrop.api.checkBucket()`. With neither option both reads answer `403 AccessDenied`, as for an R2 object token
  (spike Q8); once either is given, the other answers `404` as not configured.
- **Why:** the fake already serves this XML; passing it through costs nothing and keeps the parser under test.
- **If wrong:** apps rarely unit test `checkBucket`; the options can be documented as rarely needed.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`.

### M9-T7: `memoryStore()` leases; `{ transaction: true }` adds `store.route` with `tx` undefined

- **Decision:** `memoryStore()` returns the repository's memory store without `transaction` and without its test hooks
  (`raw`, `injectFailure`, `failNextUsageWrite`, `appRows`), so completions run under a lease, as with
  `sqlStore(executor)`; `{ transaction: false }` and `null` mean the same. `memoryStore({ transaction: true })` returns
  a `TransactionalStore<undefined>`: `transaction` runs the memory store's own, and `store.route` brands routes for it
  as the adapters do. `onComplete` of such a route receives `tx: undefined`.
- **Why:** it mirrors the adapters' `transaction: true` switch, which the design asks for ("the same route helper the
  adapters give"). The memory store's own handle (`calls`, `write`) is a test hook of this repository, and an app has
  no database here to write through; `undefined` says so in the types instead of offering a handle that writes
  nowhere.
- **If wrong:** an app whose routes are typed with its database's `tx` cannot reuse them unchanged with this store;
  it tests those writes against its database.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.ts`, `docs/guide/testing-your-app.md`.

### M9-T8: no fault injection yet

- **Decision:** the entry has no option to refuse a part or lose an answer.
- **Why:** the design asks for it only if it costs little. A public fault API needs names for requests and answers that
  apps would then depend on; the repository's `Fault` (`client-fixture.ts`) labels requests for its own assertions.
- **If wrong:** apps that test their retry UI wait for a later release.
- **Status:** in force.
- **Visible in:** `docs/decisions/m9-testing.md`.

### M9-T9: the guide's examples are a test file, checked against the guide

- **Decision:** every TypeScript block of `docs/guide/testing-your-app.md` is a piece of
  `src/testing.guide.test.ts`, with `cloudrop` and `cloudrop/testing` for its relative imports; the file's last test
  reads the guide and fails when a block is not in the file. The examples' own tests are unchanged: their only tests
  are Playwright browser tests, which the entry does not replace.
- **Why:** the design asks for docs that cannot rot. Running the guide's code is half of it; the check makes an edit
  to only the guide or only the test fail.
- **If wrong:** none known; the check reads a file under `docs/`, so moving the guide moves the path in the test.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/src/testing.guide.test.ts`, `docs/guide/testing-your-app.md`.
