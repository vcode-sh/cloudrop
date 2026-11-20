# M8-Q: the 0.2.0 code-quality pass

Rulings from the pass that shortens and modernises existing code without changing behaviour: what was simplified,
which newer platform APIs were adopted and on which evidence of support, and what was left as it is and why. Entries
continue from `M8-Q1`.

### M8-Q1: one port check for every lane script

- **Decision:** `scripts/lib.sh` holds `require_free_port <port> <what to do instead>`, and the six shell scripts that
  start a service (`test-rustfs.sh`, `test-chaos.sh`, `test-wrangler.sh`, `test-db.sh`, `test-browser.sh`,
  `postgres.sh`) call it instead of repeating the four-line `ss -ltnH` block ten times.
- **Why:** ten copies of one check, each a chance for the message or the exit code to drift. The messages and the
  exit code 1 are unchanged; only the shared prefix "Port N is in use." now comes from one place.
- **If wrong:** none known. `test-browser.sh` was checked with `bash -n` only, since this pass does not run the
  browser lane; the helper itself was run against a free and a taken port.
- **Status:** in force.
- **Visible in:** `scripts/lib.sh` and the six scripts above.

### M8-Q2: `deleteMany`'s workers share one array iterator

- **Decision:** `forEachConcurrently` (`src/storage/s3/objects.ts`) starts its workers on one `items.values()`
  iterator, each running `for (const item of queue) await task(item)`, in place of a shared index and an `as T` cast.
- **Why:** the same pool with one concept fewer and no cast. Each `next()` hands an item to exactly one worker, in
  array order, and an array iterator has no `return()`, so a worker that stops cannot close the queue for the others.
  The number of workers, the requests and their order are unchanged; "deletes more keys than one S3 batch holds"
  (1,001 keys, each deleted once) covers it.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `src/storage/s3/objects.ts`.

### M8-Q3: dev dependency updates

- **Decision:** `packages/cloudrop` moves to Vitest 5.1.1, Wrangler 4.166.0, `@cloudflare/workers-types`
  5.20261119.1, better-sqlite3 13.2.0, postgres 4.1.1 and fast-check 4.10.3. Biome 2.6.8, TypeScript 7.0.2, tsdown
  0.23.7, size-limit 14.3.0, publint 0.3.25 and attw 0.18.5 were already the latest releases.
- **Why:** the latest stable releases, read in their release notes first. Vitest 5.1.1 and fast-check 4.10.3 are bug
  fixes. Wrangler 4.163 to 4.166 change no command or API the lane uses; its workerd moves to 1.20261119.1, so the
  workers types follow that release, not the newer 5.20261120.1, as `M5-T84` pinned them to the installed workerd and as
  Wrangler's own peer range (`^5.20261119.1`) asks. better-sqlite3 13 is the first release on N-API (no other API
  change in 13.0 to 13.2). postgres 4.1 adds options and fixes; 4.1 also reads `PGSSLMODE`, which the db lane does not
  set. The lockfile also records the package's version 0.1.1, which the 0.1.1 release had left at 0.0.0.
- **If wrong:** `@prisma/adapter-better-sqlite3` 7.10.1 still depends on better-sqlite3 `^12.6.0`, so the workspace
  holds both 12.11.1 (Prisma's, built for the Node that installs it) and 13.2.0 (the Drizzle tests'). The db lane
  passes with both (594 tests, Postgres and SQLite).
- **Status:** in force. `bun run verify`, `scripts/check-drizzle-versions.sh` and `bun run test:db` pass on Node
  24.22.2.
- **Visible in:** `packages/cloudrop/package.json`, `bun.lock`.

### M8-Q4: updates left out

- **Decision:** not taken: `@types/node` 26 (stays `^24`), Prisma 8 (`8.0.0-rc.34`), a drizzle-orm other than
  1.0.0-rc.5, and the examples' dependencies.
- **Why:** Node 24 is the floor (`engines`, design spec §3), and Node 26's types would let a test or script use an API
  Node 24 lacks. Prisma 8 is a release candidate, not a stable release. drizzle-orm stays the release the adapter is
  built against, with 0.45 checked by `scripts/check-drizzle-versions.sh` (`M5-T51`). `examples/**` belongs to
  another part of the 0.2.0 pass.
- **If wrong:** none known.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/package.json`.

### M8-Q5: platform APIs not adopted

- **Decision:** `Uint8Array.prototype.toHex`, `toBase64` and `Uint8Array.fromBase64` do not replace the hand-written
  `toHex` (`src/storage/sigv4.ts`) and the `btoa` call in `crc32cBase64` (`src/checksum.ts`). `Blob.prototype.bytes()`
  does not replace the fake R2's `concat` (`src/testing/fake-r2/multipart.ts`).
- **Why:** Node 24 has none of the three `Uint8Array` methods: MDN's browser-compat-data 8.1.10 lists them from
  Node 25.0.0 (with Chrome 140, Firefox 133, Safari 18.2, Deno 2.5 and Bun 1.1.22), and Node 24.22.2 (V8 13.6) answers
  `undefined` for each (measured 2026-11-20). `Blob.bytes()` is in Node from 22.3.0, but the fake also runs under
  happy-dom in the React tests, whose `Blob` has no `bytes()` (measured: three `use-resumable` tests failed with it).
- **If wrong:** revisit the `Uint8Array` methods when the floor moves past Node 24.
- **Status:** in force.
- **Visible in:** `src/storage/sigv4.ts`, `src/checksum.ts`, `src/testing/fake-r2/multipart.ts`.

### M8-Q6: compiler options that restate TypeScript 7's defaults stay

- **Decision:** `packages/cloudrop/tsconfig.json` keeps `strict: true` and `types: []`, although TypeScript 7 applies
  `strict` by default (measured: a probe tsconfig without it reports TS7006 for an untyped parameter).
- **Why:** an editor running a bundled TypeScript 5.x reads the same file, and without the line would check the code
  without `strict`. `types: []` is how AGENTS.md says the compiler keeps Node's types out of `src/`.
- **If wrong:** none known; drop the lines once no supported editor ships TypeScript 5.
- **Status:** in force.
- **Visible in:** `packages/cloudrop/tsconfig.json`.
