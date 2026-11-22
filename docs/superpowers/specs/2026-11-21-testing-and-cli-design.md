# cloudrop/testing and the cloudrop command: design

Status: approved for implementation, 2026-11-21. Rulings are recorded as `M9-T<n>` (testing) and `M9-C<n>` (command)
in `docs/decisions/m9-testing.md` and `docs/decisions/m9-cli.md`. Source: the pilot's move to 0.2.0
(`docs/superpowers/plans/README.md`, "After 0.2.0").

## 1. `cloudrop/testing`: test an app's routes without a bucket

**Goal.** An app tests its routes, `authorize`, metadata, quotas, `onComplete`/`afterComplete` and a whole upload from
the client's point of view in Vitest, Bun or Node's test runner, with no bucket, no browser and no network.

**Shape (names are the defaults; the implementer may refine them, recording why):**

```ts
import { createCloudrop } from "cloudrop";
import { testBucket, testClient, memoryStore } from "cloudrop/testing";

const bucket = testBucket(); // the in-process fake R2
const cloudrop = createCloudrop({ storage: bucket.storage, secret: "…32+ chars…", routes /*, store: memoryStore() */ });
const client = testClient(cloudrop, { bucket, headers: { cookie: "session=alice" } });

const { data, error } = await client.upload("avatar", new File([png], "a.png", { type: "image/png" }));
expect((await bucket.object(data!.key))?.size).toBe(png.byteLength);
```

- `testBucket(options?)`: the fake R2 that `src/testing/fake-r2.ts` already is (R2's measured rules, signature checks),
  wrapped as a `StorageDriver` from the `r2()` preset with fixed test credentials, plus read-only inspection
  (`object(key)`, `keys()`, `pendingUploads()`) and the `fetch` that reaches it. Optional `publicUrl`, a clock, and
  bucket CORS/lifecycle XML for `checkBucket` tests.
- `testClient(cloudrop, options)`: `createCloudropClient` wired in-process. Requests to the upload server go to
  `cloudrop.handler` as a same-origin browser sends them (an `origin` header the handler accepts); presigned requests
  go to the test bucket. `headers` (static or a function) model the session, through the client's own `headers`
  option. Persistence is off (no IndexedDB in Node); bucket `PUT`s go through `fetch`. It is the real client, so
  progress, retries, multipart and `close()` behave as in a browser.
- `memoryStore()`: the in-memory `CloudropStore` the repository's own tests use, with the same route helper the
  adapters give (`store.route(...)`) if they do, so a test of a store app needs no database. Its contract cases run in
  the store contract suite like every adapter.
- Fault injection (refuse a part, lose an answer) only if it costs little; otherwise later.

**Rules.** Zero runtime dependencies and web-platform APIs only, like the rest of `src/`. A new entry
`cloudrop/testing` in `exports`, its own size budget, and no import of it from any other entry (the server and client
bundles must not grow). Its public surface is small and documented; internal fixtures stay internal. A guide
`docs/guide/testing-your-app.md` (the existing `testing.md` stays the contributor page) with one Vitest example per
case: an `authorize` refusal, a metadata error, a quota refusal, an `onComplete` result, a multipart file. The
examples' own tests use the entry where that removes code.

## 2. The `cloudrop` command: `doctor` and `setup`

**Goal.** One command tells a developer, in plain words, what is missing in their environment and bucket, and another
sets the bucket's CORS and lifecycle rules without hand-written JSON.

```bash
npx cloudrop doctor --origin https://app.example.com --origin http://localhost:5173
npx cloudrop setup  --origin https://app.example.com            # prints the rules and the commands
npx cloudrop setup  --origin https://app.example.com --apply    # writes them through the S3 API
```

- **Configuration:** the same environment variables as the presets (`CLOUDROP_R2_*`, `CLOUDROP_S3_*`,
  `CLOUDROP_SECRET`), read the way `src/env.ts` reads them, and `--env-file <path>` for a dotenv file (parsed by the
  command itself: no dependency). Never print a secret, a key or a presigned URL; name a variable, never its value.
- **`doctor`:** checks that every setting is present and valid (with the variable to fix), that the bucket answers
  (a `HEAD` of a key that does not exist), and runs `checkBucket` for the given origins. Each line is one finding and
  what to do. Exit 0 when nothing is wrong, 1 when something is, 2 on a usage error. `unknown` (an R2 object token
  cannot read bucket settings) is reported as "could not check" with how to check by hand, not as a failure.
- **`setup`:** prints the CORS rule (R2 and S3 formats) and the lifecycle rule for the given origins and the exact
  `wrangler` and `aws` commands, as `docs/guide/bucket-setup.md` describes. With `--apply` it writes them through
  `PutBucketCors` and `PutBucketLifecycleConfiguration`, which need credentials allowed to change bucket settings.
  **It merges, never replaces:** it reads the current rules, adds or updates only cloudrop's own rule (found by its
  ID, such as `cloudrop-uploads` and `cloudrop-abort-incomplete`), and keeps every other rule. `--dry-run` shows the
  merged result without writing. It refuses to write when it cannot read the current rules, unless `--replace` says
  replacing them is intended.
- **Where it runs:** Node 24+ (Node 26+ since 1.0, `M12-P2`) and Bun (`npx`, `bunx`). The command is a separate entry
  (`bin` in `package.json`) that no library entry imports. It may use `process` (described by hand, as `src/node.ts`
  does) and nothing else outside the web platform.
- **Storage layer:** the driver gains optional `putBucketCors` and `putBucketLifecycle` (optional, so a hand-written
  driver still type-checks), implemented in the S3 driver with the XML the S3 API documents, faked in the fake R2, and
  covered by the storage contract where the backend supports them (RustFS; Wrangler's local R2 reports its gap as a
  capability skip).
- **Live R2:** never change the live test bucket's settings (`AGENTS.md`: only when the owner asks). R2 support of the
  two write calls is taken from Cloudflare's R2 S3 compatibility page and recorded with the link; the live lane may only
  read.

## 3. Out of scope

`api.files` filters, a client option for the account header, UI components (`M4-E1`), the M6 plugins.
