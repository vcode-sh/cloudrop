# M3 progress and pool, plan A: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cloudrop/client` reports each file's bytes, speed and time left while it uploads, sends several files in one
job through one connection pool per client, and can pause, resume and cancel each file or the whole job.

**Architecture:** The per-file logic of the slice stays (`client/upload.ts`, `client/parts.ts`: renewal,
`PARTS_MISSING` repair, the retry budget, keep-or-abort). Around it come five small modules: `transport.ts` (XHR with
`upload.onprogress`, or `fetch`), `progress.ts` (bytes that never go backwards, EWMA speed), `store.ts` (the immutable
snapshot and its throttled listeners), `pool.ts` (connection slots shared by the client) and `job.ts` (`start()`: one
`/upload` for every file, per-file runs, the `UploadResult`). Every bucket PUT takes a pool slot through the
`PartSender.put` wrapper in `upload.ts`, so `parts.ts` does not change.

**Tech Stack:** TypeScript 7, web-platform APIs only (`fetch`, `XMLHttpRequest`, `AbortSignal.any`), Vitest 5 with fake
timers, the in-process fake R2, Playwright for the browser lane, Next.js for the example.

**Spec:** [`docs/superpowers/specs/2026-11-16-progress-scheduler-design.md`](../specs/2026-11-16-progress-scheduler-design.md)
(approved by the owner 2026-11-16). Parent: [`2026-11-15-cloudrop-design.md`](../specs/2026-11-15-cloudrop-design.md)
§6.1, §6.2, §6.4. Plan B (auto concurrency, smallest-first, stalls, offline, `retry()`, part size) follows this plan.

## Global Constraints

- Everything in English: code, comments, messages, docs, commit messages.
- `packages/cloudrop` has zero runtime dependencies and uses only web-platform APIs in `src/`; the client imports only
  `errors.ts`, `input.ts`, `plan.ts` and `protocol/types.ts` from outside `client/` (Biome rule in `biome.json`).
- Source files aim at 200 to 220 lines; `bun run check` fails a source file over 250 lines, a `*.test.ts` over 400, a
  function over cognitive complexity 15.
- Tests sit next to the source (`foo.ts` beside `foo.test.ts`); load the `testing-patterns` skill before writing tests
  and the `code-quality` skill before committing. Expected values are independent literals; doubles only for network,
  clock and randomness; never `vi.mock` our own modules.
- Public calls return `{ data, error }`; `UploadResult` keeps `data.files` on a partial failure (spec §2.2). Messages
  say what happened and what to do next and never contain a URL, token or storage answer.
- Never log a presigned URL or a token, in code, tests, the lab page or reports.
- `concurrency` in plan A: a whole number from 1 to 16, default 4. No `"auto"` and no `order` option yet (plan B).
- `PARTS_IN_FLIGHT` stays 4 per file. The retry budget (`MAX_ATTEMPTS` 6, full jitter) does not change.
- A failed file still sends the background `/abort` of `M3-S15` in plan A. The failed-file rule of spec §4.7 and
  `retry()` are plan B; do not add them, and add no `retry` method or stub.
- Snapshot listeners: at most one call per 100 ms while bytes flow, at once on every status change.
- Git: stage exact paths, conventional commits, never push. Never `git stash`, `reset`, `clean` or `checkout --`.
- Gates: `bun run verify` for every task (Node 24: `PATH=~/.nvm/versions/node/v24.22.2/bin:$PATH`).
  `bun run test:browser` for tasks that change what a browser sends (named per task); it needs Docker and port 5173
  free, and removes its RustFS container. Docker containers from tests carry the label `cloudrop.test`.
- Live R2 (`bun run test:browser:live`) only in Task 7, with `CLOUDROP_R2_ENV_FILE=~/.config/cloudrop/live-r2.env`;
  never read or print that file.
- Decisions taken while executing go to the ledger as rulings; Task 8 writes them to `docs/decisions/m3-uploader.md`
  (series `M3-U`).

## Rulings fixed by this plan (spec §9 and gaps the spec leaves)

These are part of the requirements. Task 8 records each as an `M3-U` entry.

- **P1. No `job.file(id)`.** `job.files[i]` and `snapshot.files[i]` are in the order the files were passed; the example
  needs nothing else.
- **P2. File ids** are the client's sequence number as text (`"1"`, `"2"`, …), counted across every job of one client:
  unique per client, stable for the job's life, readable in tests. Not `crypto.randomUUID()`, which a page served over
  plain HTTP on a LAN address does not have.
- **P3. The first error** of `UploadResult` is the error of the first file, in the order passed, that did not end done.
- **P4. A file that is completing ignores `pause()`**: its bytes are all sent and `/complete` runs without the pass's
  signal (`M3-S14`). A `PARTS_MISSING` repair turns it back to uploading, where pause applies again.
- **P5. `upload(route, file)` with one `File`** returns that file's `Result` as before; its error now carries
  `error.file` like every per-file error. A list (`File[]` or `FileList`) returns the job's `UploadResult`.
- **P6. The transport is chosen once, when the client is created:** XHR when `globalThis.XMLHttpRequest` is a function
  and no `fetch` option was passed; otherwise the `fetch` path, which reports a part's bytes when its answer arrives.
  The XHR constructor is read from `globalThis` on every PUT, so a page that wraps it later (the lab) is seen.
- **P7. The store refreshes once a second while a file is uploading**, even without new bytes, so a stalled transfer
  shows its speed decaying (spec §4.3); it schedules nothing once no file is uploading.
- **P8. A listener that throws** does not stop the upload or the other listeners; its error is thrown again from a
  `setTimeout`, so the page still sees it as an uncaught error.
- **P9. Pool order** is the file's rank, then the part number; equal ranks keep arrival order. The rank is the file id
  as a number, so files added earlier send first, across jobs of the same client.

## File map

| File | State | Responsibility |
|---|---|---|
| `packages/cloudrop/src/client/transport.ts` | new | `createPut()`: one presigned PUT through XHR (progress events) or `fetch` (bytes at the end) |
| `packages/cloudrop/src/client/bucket.ts` | changed | Exports `STORAGE_CODE` and `unreachable()` for the XHR path; `putObject` unchanged |
| `packages/cloudrop/src/testing/fake-xhr.ts` | new | A fake `XMLHttpRequest` over the client fixture's fetch, progress on demand; never shipped |
| `packages/cloudrop/src/client/progress.ts` | new | `createProgress()` (best bytes per part) and `createMeter()` (EWMA, 3 s) |
| `packages/cloudrop/src/client/store.ts` | new | `createStore()`: cached snapshot, 100 ms throttle, 1 s refresh while active |
| `packages/cloudrop/src/client/pool.ts` | new | `createPool()`: slots, ranked queue, release once |
| `packages/cloudrop/src/client/arguments.ts` | new | `readArguments()` moved out of `upload.ts`, now for one file or a list |
| `packages/cloudrop/src/client/upload.ts` | changed | `runFile()`: one file of a job, from its ticket to its outcome, with pass and pause |
| `packages/cloudrop/src/client/job.ts` | new | `startJob()`: one `/upload`, the entries, handles, snapshot, `UploadResult` |
| `packages/cloudrop/src/client/types.ts` | new | Public types: `FileStatus`, `FileSnapshot`, `JobSnapshot`, `FileOutcome`, `UploadResult`, `UploadJob`, `FileHandle` |
| `packages/cloudrop/src/client/endpoints.ts`, `answers.ts` | changed | `/upload` for several files; `readTickets()` |
| `packages/cloudrop/src/client.ts` | changed | `concurrency`, the pool, `start()`, the `upload()` overloads, the new type exports |
| `packages/cloudrop/src/errors.ts` | changed | `CloudropError.file` and the `file` option |
| `examples/next/app/lab/*`, `examples/next/app/lab.browser.test.ts` | changed | The lab shows the snapshot; XHR and fetch wrappers; browser rows |
| `scripts/size-limit.config.ts` | changed | The `cloudrop/client` budget from the measured size |
| `docs/decisions/m3-uploader.md` (new), `docs/decisions/README.md`, `AGENTS.md`, `README.md`, specs, plans README | changed | Decisions `M3-U`, the job API, spec §1 |

---

### Task 1: Transport and the fake XHR

**Files:**
- Create: `packages/cloudrop/src/client/transport.ts`, `packages/cloudrop/src/client/transport.test.ts`,
  `packages/cloudrop/src/testing/fake-xhr.ts`
- Modify: `packages/cloudrop/src/client/bucket.ts`, `packages/cloudrop/src/client/upload.ts` (`UploadContext`,
  `senderFor`), `packages/cloudrop/src/client.ts` (builds the context)

**Interfaces:**
- Consumes: `classifyAnswer`, `putObject`, `BucketOutcome` (`bucket.ts`); `parseRetryAfter` (`retry.ts`);
  `aborted`, `bucketUnreachable` (`failures.ts`); `ClientFetch` (`endpoints.ts`); `clientFixture` (testing).
- Produces:
  ```ts
  // client/transport.ts
  export type PutObject = (
    target: SignedRequest,
    body: Blob,
    signal: AbortSignal,
    /** The bytes of `body` sent so far by this attempt; with fetch, called once with body.size when it is stored. */
    onBytes: (sent: number) => void,
  ) => Promise<BucketOutcome>;
  export function createPut(fetchOption: ClientFetch | undefined, send: ClientFetch): PutObject;
  // client/upload.ts
  export interface UploadContext { endpoints: Endpoints; put: PutObject }   // `fetch` is gone from the context
  // testing/fake-xhr.ts
  export interface XhrCall {
    readonly label: string;          // as clientFixture labels requests: "PUT object", "PUT part 2"
    readonly size: number;           // the body's bytes
    progress(loaded: number): void;  // fires upload.onprogress
    finish(): Promise<void>;         // sends through the fixture's fetch; fires onload, or onerror when it throws
    fail(): void;                    // fires onerror, as a browser does for a network or CORS failure
  }
  export interface FakeXhr {
    /** For vi.stubGlobal("XMLHttpRequest", xhr.XMLHttpRequest). */
    XMLHttpRequest: new () => unknown;
    /** Requests sent and not yet finished, failed or aborted, oldest first. Only `hold: true` leaves any here. */
    open: XhrCall[];
  }
  /** Without `hold`, each request reports half its body, then all of it, then finishes by itself. */
  export function fakeXhr(fetch: ClientFetch, options?: { hold?: boolean }): FakeXhr;
  ```

- [ ] **Step 1: Write the fake XHR** (`src/testing/fake-xhr.ts`). It implements only what `transport.ts` uses:
  `open(method, url)`, `setRequestHeader(name, value)`, `send(body: Blob)`, `abort()`, the properties `upload.onprogress`,
  `onload`, `onerror`, `onabort`, `ontimeout`, `status`, `responseText`, `getResponseHeader(name)`. `send` builds an
  `XhrCall` whose `finish()` calls `fetch(url, { method, headers, body })` (no signal; the label comes from the
  fixture's own request log, so compute it the same way: `partNumber` query parameter → `PUT part n`, otherwise
  `PUT object`). A call that was aborted ignores a later `finish()`, `progress()` or `fail()`; `abort()` fires
  `onabort` once and removes the call from `open`. `progress(loaded)` calls `upload.onprogress({ loaded, total: size,
  lengthComputable: true })`. Without `hold`, `send` queues a microtask that calls `progress(size / 2 rounded down)`,
  `progress(size)`, then `finish()`. Header comment: what it fakes and that it is never shipped.

- [ ] **Step 2: Write the failing tests** (`client/transport.test.ts`). Contract: spec §4.1 and `M3-S10`: the XHR path
  classifies every answer exactly as the fetch path and reports bytes while sending. Oracle: `bucket.test.ts`'s rows
  for the same statuses, and the fake R2's stored bytes. Use `vi.stubGlobal` for `XMLHttpRequest` and `fetch` and
  `vi.unstubAllGlobals()` in `afterEach`; a client with only `basePath` then uses XHR for PUTs and the global fetch for
  the server. Rows:
  1. A 1000-byte file through `createCloudropClient({ basePath })` with both globals stubbed: the result is the route's
     result, the stored bytes equal the file, `fixture.requests` is `["POST /upload", "PUT object", "POST /complete"]`.
  2. `createPut` directly (XHR path), held: `onBytes` receives `[500, 1000]` for `progress(500)`, `progress(1000)`, then
     `1000` once more when the answer is stored → the recorded list is `[500, 1000, 1000]` and the outcome is
     `{ kind: "stored" }`.
  3. Answers by status through a fixture `fault` (the fault returns the `Response`): `412` → `stored`; `403` with body
     `<Error><Code>SignatureDoesNotMatch</Code></Error>` → `rejected` with code `UPLOAD_REJECTED`; `403` with
     `<Code>AccessDenied</Code>` → `expired`; `503` with `retry-after: 7` → `retry`, code `RATE_LIMITED`,
     `retryAfterMs: 7000`; `500` → `retry`, code `STORAGE_ERROR`; `400` → `rejected`. One `it.each` with `$name`.
  4. `fail()` → `{ kind: "opaque", retryAfterMs: 0 }` with code `NETWORK_ERROR`.
  5. The signal aborted while the call is open → `{ kind: "aborted" }` with code `ABORTED`, and `open` is empty.
  6. A signal already aborted → `aborted` and no request in `fixture.requests`.
  7. `createPut(fetchOption, send)` with a `fetch` option while `XMLHttpRequest` is stubbed: the request goes through
     the option (the fake XHR's `open` stays empty) and `onBytes` is called once with the body size.
  Run: `cd packages/cloudrop && bunx vitest run --project unit src/client/transport.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `transport.ts`.** Export `STORAGE_CODE` and a helper `unreachable(signal)` from `bucket.ts`
  (the `catch` branch of `putObject` becomes `return unreachable(signal)`), so both paths share them:

  ```ts
  // One presigned PUT to the bucket. In a browser it goes through XMLHttpRequest, the one web API that reports upload
  // progress; with a fetch option, or where there is no XMLHttpRequest, through fetch, which reports a part's bytes only
  // when it is stored (spec §4.1, plan A ruling P6).

  import type { SignedRequest } from "../protocol/types.ts";
  import { type BucketOutcome, classifyAnswer, putObject, STORAGE_CODE, unreachable } from "./bucket.ts";
  import type { ClientFetch } from "./endpoints.ts";
  import { parseRetryAfter } from "./retry.ts";

  export type PutObject = (/* as in Interfaces */) => Promise<BucketOutcome>;

  function putWithXhr(target: SignedRequest, body: Blob, signal: AbortSignal, onBytes: (sent: number) => void) {
    return new Promise<BucketOutcome>((resolve) => {
      if (signal.aborted) return resolve(unreachable(signal));
      // Read on every PUT, so a page that wraps XMLHttpRequest after the client was created is seen (ruling P6).
      const xhr = new globalThis.XMLHttpRequest();
      const cancel = () => xhr.abort();
      const settle = (outcome: BucketOutcome) => {
        signal.removeEventListener("abort", cancel);
        resolve(outcome);
      };
      xhr.open("PUT", target.url);
      for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => onBytes(event.loaded);
      xhr.onload = () => {
        // 412: a retried create-only PUT whose first attempt already stored the object (spec §5.4).
        if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 412) {
          onBytes(body.size);
          return settle({ kind: "stored" });
        }
        if (xhr.status === 0) return settle(unreachable(signal));
        const code = STORAGE_CODE.exec(xhr.responseText)?.[1];
        settle(classifyAnswer(xhr.status, code, parseRetryAfter(xhr.getResponseHeader("retry-after"))));
      };
      // A network failure and a refusal without CORS headers look the same here, as with fetch (M3-S10).
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => settle(unreachable(signal));
      signal.addEventListener("abort", cancel, { once: true });
      // No cookies: XMLHttpRequest sends none cross-origin unless withCredentials is set, and it stays unset.
      xhr.send(body);
    });
  }

  export function createPut(fetchOption: ClientFetch | undefined, send: ClientFetch): PutObject {
    if (fetchOption === undefined && typeof globalThis.XMLHttpRequest === "function") return putWithXhr;
    return async (target, body, signal, onBytes) => {
      const outcome = await putObject(send, target, body, signal);
      if (outcome.kind === "stored") onBytes(body.size);
      return outcome;
    };
  }
  ```

  `unreachable(signal)` returns `{ kind: "aborted", error: aborted() }` when the signal fired, else
  `{ kind: "opaque", error: bucketUnreachable(), retryAfterMs: 0 }` (today's `catch` branch, moved).

- [ ] **Step 4: Wire it in.** `UploadContext` becomes `{ endpoints, put }`; `senderFor` calls
  `context.put(target, bodyOf(...), signal, () => {})` (Task 4 replaces the no-op with progress). `client.ts` builds
  `put: createPut(fetch, send)` where `fetch` is the option as passed and `send` the resolved fetch. Existing tests pass
  a `fetch` option, so they keep the fetch path and must pass unchanged.

- [ ] **Step 5: Run** `bun run verify` → PASS, then `bun run test:browser` → 6/6 PASS: the quickstart and the lab now
  send PUTs through real XHR (the lab still passes its own `fetch`, so its PUTs stay on fetch until Task 7).

- [ ] **Step 6: Commit** `feat(client): send bucket PUTs through XMLHttpRequest in a browser` (stage the five files).

---

### Task 2: Progress accounting, speed and the store

**Files:**
- Create: `packages/cloudrop/src/client/progress.ts`, `progress.test.ts`, `store.ts`, `store.test.ts` (all in
  `packages/cloudrop/src/client/`)

**Interfaces:**
- Produces:
  ```ts
  // client/progress.ts
  export interface Progress {
    /** Bytes counted for the file: the sum over its parts of the most each attempt ever sent. Never decreases. */
    readonly bytes: number;
    /** The current attempt of `part` has sent `sent` of `partSize` bytes. Returns what this added to `bytes`. */
    sent(part: number, sent: number, partSize: number): number;
  }
  export function createProgress(): Progress;
  export interface Meter {
    /** `bytes` more were sent by `now` (ms). */
    add(bytes: number, now: number): void;
    /** Bytes per second at `now`, decayed since the last add. */
    speed(now: number): number;
    /** Starts from 0 at `now`: when a file starts or resumes sending. */
    restart(now: number): void;
  }
  export function createMeter(now: number): Meter;
  // client/store.ts
  export interface Store<T> {
    get(): T;
    subscribe(listener: () => void): () => void;
    /** Something changed: `urgent` (a status) publishes now; bytes publish at most every 100 ms. */
    changed(urgent: boolean): void;
  }
  export function createStore<T>(build: () => T, active: () => boolean): Store<T>;
  ```

- [ ] **Step 1: Write the failing tests.** Contract: spec §4.2, §4.3, §2.1; rulings P7, P8. Oracles are hand-worked:
  - `progress.test.ts`:
    1. Part 1 (size 100) reports 40, then a re-sent attempt reports 10, 30, 60 → returns `[40, 0, 0, 20]`, `bytes` 60.
    2. Reports above the part size count only up to it: `sent(1, 150, 100)` returns 100.
    3. Two parts (100 and 50) both stored → `bytes` 150.
  - `progress.test.ts`, meter (EWMA, time constant 3000 ms, α = 1 − e^(−Δt/3000)):
    1. `restart(0)`, `add(1000, 1000)` → `speed(1000)` ≈ 283.4687 (`toBeCloseTo(283.4687, 3)`); then `add(1000, 2000)`
       → `speed(2000)` ≈ 486.5829; `speed(5000)` ≈ 179.0038 (decayed by e^(−1)).
    2. Bytes reported at the same millisecond are kept and counted with the next add: `restart(0)`, `add(1000, 0)`,
       `add(2000, 500)` → `speed(500)` ≈ 921.1097 (3000 bytes over 500 ms, α = 1 − e^(−1/6)).
    3. `restart` sets the speed back to 0.
  - `store.test.ts` (fake timers; `build` returns `{ n: counter }` objects so identity is observable):
    1. `get()` returns the same object until a publish, then a new one.
    2. Three `changed(false)` within 30 ms → one listener call, 100 ms after the previous publish.
    3. `changed(true)` calls listeners at once, also inside the 100 ms window, and cancels the pending throttled call
       (one call, not two).
    4. While `active()` is true, a publish follows 1000 ms after the last one without any `changed`; once `active()` is
       false, no timer is left (`vi.getTimerCount()` is 0).
    5. A listener that throws: the next listener is still called, and advancing timers throws its error (`expect(() =>
       vi.runOnlyPendingTimers()).toThrow("listener failed")`).
    6. The function `subscribe` returns removes the listener.
  Run the two files → FAIL.

- [ ] **Step 2: Implement `progress.ts`.**

  ```ts
  // How much of a file has been sent (spec §4.2) and how fast (spec §4.3).

  /** The speed's time constant: the average follows a change in rate within about 3 s. */
  const TIME_CONSTANT_MS = 3000;

  export function createProgress(): Progress {
    const best = new Map<number, number>();
    let bytes = 0;
    return {
      get bytes() {
        return bytes;
      },
      sent(part, sent, partSize) {
        const before = best.get(part) ?? 0;
        const reached = Math.min(sent, partSize);
        // A re-sent attempt adds nothing until it passes what an earlier attempt of the same part reached.
        if (reached <= before) return 0;
        best.set(part, reached);
        bytes += reached - before;
        return reached - before;
      },
    };
  }

  export function createMeter(now: number): Meter {
    let rate = 0;
    let last = now;
    // Bytes reported in the same millisecond as `last`: no time has passed to divide them by.
    let pending = 0;
    return {
      add(bytes, at) {
        const elapsed = at - last;
        if (elapsed <= 0) {
          pending += bytes;
          return;
        }
        const alpha = 1 - Math.exp(-elapsed / TIME_CONSTANT_MS);
        rate += alpha * (((bytes + pending) * 1000) / elapsed - rate);
        pending = 0;
        last = at;
      },
      speed: (at) => rate * Math.exp(-Math.max(0, at - last) / TIME_CONSTANT_MS),
      restart(at) {
        rate = 0;
        last = at;
        pending = 0;
      },
    };
  }
  ```

- [ ] **Step 3: Implement `store.ts`.**

  ```ts
  // The snapshot a page renders (spec §2.1): the same object until something changes, listeners at most every 100 ms
  // while bytes flow and at once on a status change, and a refresh every second while a file uploads (ruling P7).

  const THROTTLE_MS = 100;
  const REFRESH_MS = 1000;

  export function createStore<T>(build: () => T, active: () => boolean): Store<T> {
    let snapshot = build();
    let lastMs = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dueMs = Number.POSITIVE_INFINITY;
    const listeners = new Set<() => void>();

    const schedule = (atMs: number) => {
      if (timer !== undefined && dueMs <= atMs) return;
      clearTimeout(timer);
      dueMs = atMs;
      timer = setTimeout(publish, Math.max(0, atMs - Date.now()));
    };
    function publish() {
      clearTimeout(timer);
      timer = undefined;
      dueMs = Number.POSITIVE_INFINITY;
      snapshot = build();
      lastMs = Date.now();
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          // The upload and the other listeners go on; the page still sees the error as uncaught (ruling P8).
          setTimeout(() => {
            throw error;
          });
        }
      }
      if (active()) schedule(lastMs + REFRESH_MS);
    }
    return {
      get: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      changed: (urgent) => (urgent ? publish() : schedule(lastMs + THROTTLE_MS)),
    };
  }
  ```

- [ ] **Step 4: Run** both test files → PASS; `bun run verify` → PASS.
- [ ] **Step 5: Commit** `feat(client): count bytes, measure speed and publish snapshots`.

---

### Task 3: The connection pool

**Files:**
- Create: `packages/cloudrop/src/client/pool.ts`, `pool.test.ts`
- Modify: `packages/cloudrop/src/client/upload.ts` (`UploadContext.pool`, the `put` wrapper in `senderFor`),
  `packages/cloudrop/src/client.ts` (`concurrency` option, one pool per client), `client/upload.test.ts` (one row)

**Interfaces:**
- Consumes: `PutObject` (Task 1).
- Produces:
  ```ts
  // client/pool.ts
  export type Release = () => void;
  export interface Pool {
    /** Waits for a free slot, lower rank first (compared element by element, ties in arrival order); null when the
     * signal fires first. Calling the release more than once frees one slot. */
    acquire(rank: readonly number[], signal: AbortSignal): Promise<Release | null>;
  }
  export function createPool(size: number): Pool;
  // client/upload.ts
  export interface UploadContext { endpoints: Endpoints; put: PutObject; pool: Pool; nextRank(): number }
  // client.ts
  export interface ClientOptions { basePath?: string; fetch?: ClientFetch; concurrency?: number }
  ```

- [ ] **Step 1: Write the failing tests** (`pool.test.ts`). Contract: spec §4.4, ruling P9. Rows:
  1. Size 2: three acquires → two resolve at once, the third after one release.
  2. Order: with size 1 held, acquires with ranks `[2, 1]`, `[1, 3]`, `[1, 2]`, `[2, 1]` (second) → granted in the order
     `[1, 2]`, `[1, 3]`, `[2, 1]` (first), `[2, 1]` (second).
  3. A waiting acquire whose signal fires resolves `null` and is skipped: the next release goes to the one behind it.
  4. Releasing twice frees one slot: size 1, release twice, then two acquires → one resolves, one waits.
  5. A signal already aborted → `null` without taking a slot.
- [ ] **Step 2: Implement `pool.ts`** (about 50 lines):

  ```ts
  // The connection slots one client shares between all its uploads (spec §4.4). A slot is held by one bucket PUT;
  // calls to the upload server take none.

  const before = (a: readonly number[], b: readonly number[]): boolean => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
    return false;
  };

  export function createPool(size: number): Pool {
    let free = size;
    const waiting: { rank: readonly number[]; grant: (release: Release) => void }[] = [];
    const releaser = (): Release => {
      let used = false;
      return () => {
        if (used) return;
        used = true;
        const next = waiting.shift();
        if (next) next.grant(releaser());
        else free++;
      };
    };
    return {
      acquire(rank, signal) {
        if (signal.aborted) return Promise.resolve(null);
        if (free > 0) {
          free--;
          return Promise.resolve(releaser());
        }
        return new Promise((resolve) => {
          const drop = () => {
            waiting.splice(waiting.indexOf(entry), 1);
            resolve(null);
          };
          const entry = {
            rank,
            grant: (release: Release) => {
              signal.removeEventListener("abort", drop);
              resolve(release);
            },
          };
          const at = waiting.findIndex((other) => before(rank, other.rank));
          waiting.splice(at === -1 ? waiting.length : at, 0, entry);
          signal.addEventListener("abort", drop, { once: true });
        });
      },
    };
  }
  ```

- [ ] **Step 3: Use it.** In `senderFor`, `put` becomes: acquire `[rank, partNumber]` with the PUT's signal (`null` →
  `{ kind: "aborted", error: aborted() }`), send, release in `finally`. Until Task 4 gives files a rank, `uploadFile`
  takes the next value of a counter that `client.ts` owns (`context.nextRank()`, counting from 1). The slot is released before
  a retry's wait, so a waiting part never holds one. `createCloudropClient` reads `concurrency` (default 4) and
  throws `configError("concurrency must be a whole number from 1 to 16.")` for anything else (a non-number, 0, 17, 2.5,
  `NaN`). One pool per client.
- [ ] **Step 4: Client rows** in `upload.test.ts` (or a new `client/pool.client.test.ts` if `upload.test.ts` would pass
  400 lines; keep the `*.test.ts` suffix): two concurrent `upload()` calls of 3-part files on one client with
  `concurrency: 2`, through a fixture `fault` that counts PUTs in flight (increment on call, `await` a resolved promise,
  forward, decrement): the most in flight is 2 and both results are done. A second row with `concurrency: 16` and one
  3-part file shows 3 in flight at most, and one with 9 parts (`multipartThreshold: "8MB"` and a file of 8 MiB × 8 + 1
  bytes) shows exactly 4: the per-file cap holds. Plus the `concurrency` refusals as one `it.each` in the client's
  options tests (find where `basePath` refusals are tested and extend that table).
- [ ] **Step 5: Run** `bun run verify` → PASS.
- [ ] **Step 6: Commit** `feat(client): share one connection pool per client`.

---

### Task 4: `start()`: several files, one `/upload`, `UploadResult`

**Files:**
- Create: `packages/cloudrop/src/client/arguments.ts`, `arguments.test.ts`, `job.ts`, `job.test.ts`, `types.ts`
- Modify: `packages/cloudrop/src/client/upload.ts` (becomes `runFile`), `endpoints.ts`, `answers.ts`,
  `packages/cloudrop/src/client.ts`, `packages/cloudrop/src/errors.ts`, `client/types.test.ts`, existing client tests
  that call `endpoints.start` or `uploadFile` directly (`endpoints.test.ts`)

**Interfaces:**
- Consumes: `UploadContext` with `pool` (Task 3); `withRetry`, `aborted`.
- Produces:
  ```ts
  // errors.ts: CloudropError gains
  readonly file: { id: string; name: string } | undefined;   // set on errors that belong to one file of a job
  // CloudropErrorOptions gains `file?: { id: string; name: string }`
  // client/types.ts (all exported from cloudrop/client)
  export type FileStatus = "queued" | "uploading" | "paused" | "completing" | "done" | "failed" | "aborted";
  export type FileOutcome<R> =
    | { id: string; name: string; status: "done"; result: CompleteResponse<R> }
    | { id: string; name: string; status: "failed" | "aborted"; error: CloudropError };
  export type UploadResult<R> =
    | { data: { files: FileOutcome<R>[] }; error: null }
    | { data: { files: FileOutcome<R>[] }; error: CloudropError }
    | { data: null; error: CloudropError };
  export interface FileHandle { readonly id: string; readonly name: string; abort(): void }  // Task 6 adds pause, resume
  export interface UploadJob<R> {
    readonly files: readonly FileHandle[];
    /** Settles once, when every file has settled. Never rejects. */
    readonly done: Promise<UploadResult<R>>;
    /** Cancels every file, as the signal does. */
    abort(): void;
  }                                                   // Task 5 adds subscribe, getSnapshot; Task 6 pause, resume
  // client/endpoints.ts
  start(route: string, files: readonly File[], metadata: unknown, signal: AbortSignal):
    Promise<Result<(Ticket | CloudropError)[]>>;      // one entry per file, in order; a rejected file is its error
  // client/answers.ts
  export function readTickets(json: unknown, files: readonly File[]): (Ticket | ErrorBody)[] | null;  // replaces readTicket
  // client/arguments.ts
  export function readArguments(route: unknown, files: unknown, options: unknown):
    Result<{ route: string; files: File[]; metadata: unknown; signal: AbortSignal }>;
  // client/upload.ts
  export interface Entry {
    readonly id: string; readonly file: File; readonly rank: number;
    status: FileStatus; result: CompleteResponse<unknown> | null; error: CloudropError | null;
    /** Fires on abort() of the file or the job, and when the job's signal fires. */
    readonly cancel: AbortController;
    /** Tells the job something changed; `urgent` for a status change. */
    changed(urgent: boolean): void;
  }
  export function runFile(context: UploadContext, entry: Entry, ticket: Ticket): Promise<void>;
  // client/job.ts
  export function startJob(context: UploadContext, route: unknown, files: unknown, options: unknown): UploadJob<unknown>;
  // client.ts: CloudropClient gains
  start<TName extends RouteName<TCloudrop>>(route: TName, files: File | readonly File[] | FileList,
    ...options: UploadArguments<RouteMetadata<TCloudrop, TName>>): UploadJob<RouteResult<TCloudrop, TName>>;
  upload(route, file: File, ...options): Promise<Result<CompleteResponse<R>>>;          // overload 1, unchanged
  upload(route, files: readonly File[] | FileList, ...options): Promise<UploadResult<R>>;  // overload 2
  ```

- [ ] **Step 1: Arguments.** Move `readArguments` and `encodesAsJson` from `upload.ts` to `arguments.ts` and accept a
  `File`, an array of `File` or a `FileList` (`typeof FileList !== "undefined" && files instanceof FileList`). Messages
  (exact):
  - not a `File`, array or `FileList`: unchanged, `Pass the file as a File, such as one from <input type="file">.`
  - a list holding something else: `Pass the files as File objects, such as input.files from <input type="file" multiple>.`
  - an empty list: `Pass at least one file to upload.`
  Every other message stays as it is. `arguments.test.ts` takes over the argument rows of `upload.test.ts` that call
  `upload()` with bad input only if `upload.test.ts` would otherwise pass 400 lines; add rows for the three list cases.
- [ ] **Step 2: Several files on the wire.** `endpoints.start` sends every descriptor in one `UploadRequest` and reads
  the answer with `readTickets`, which requires `json.files.length === files.length` and checks each ticket against its
  own file's size (`isMultipart(ticket, files[i].size)`), returning `null` (→ `unreadableAnswer`) otherwise. A rejected
  ticket becomes that file's `CloudropError` (`toError`). Update `endpoints.test.ts` and `answers` rows: add one row
  with two files where the server rejects the second (`FILE_TOO_LARGE` from a route with `maxSize: 16`): the answer is
  `[ticket, error]` with the server's code, and one row where the answer holds one ticket for two files → `SERVER_ERROR`.
- [ ] **Step 3: `CloudropError.file`.** Add the field and option in `errors.ts` (doc comment: "The file of a job this
  error belongs to; undefined for an error of the whole job or of the server"). Adding a public field is a minor semver
  change; say so in the commit body.
- [ ] **Step 4: `runFile`.** Rewrite `uploadFile` in `upload.ts` as `runFile(context, entry, ticket)`. It owns what
  `uploadFile` did after `/upload`: `sendAndComplete`, keep-or-abort, the background `/abort` after a failure
  (`M3-S15`, unchanged in plan A), awaiting `/abort` after a cancel. The signal is `entry.cancel.signal`. It sets, in
  this order, `entry.status` and calls `entry.changed(true)` on each change:
  - `queued` → `uploading` when a PUT of the file gets a pool slot (in the `put` wrapper, only if not yet
    `uploading`);
  - `completing` before each `/complete` round;
  - `done` with `entry.result`, or `failed` / `aborted` with `entry.error = withFile(error, entry)`.
  The pool rank is `[entry.rank, partNumber]`. `withFile` copies the error with `file: { id, name }` (a new
  `CloudropError` with the same code, message, `retryable`, `status`, `storageCode`, `parts`, and the original as
  `cause`). A file whose `entry.cancel` fired before `runFile` starts ends `aborted` and sends `/abort` for its ticket
  (awaited).
- [ ] **Step 5: `startJob`** in `job.ts`:
  1. `readArguments`; on error return a job with no files and `done` resolved to `{ data: null, error }`.
  2. One `Entry` per file: `id = String(rank)`, `rank = context.nextRank()`, status `queued`. A job controller links
     the caller's signal and `job.abort()`; when it fires, every entry's `cancel` aborts.
  3. `withRetry(() => endpoints.start(...), jobSignal)`. On error: every entry ends `aborted` (when the job signal
     fired; the error is `aborted()`) or `failed` with the error as is (no `file`), and `done` is
     `{ data: null, error }`.
  4. For each file: a `CloudropError` ticket → the entry ends `failed` with `withFile(error, entry)`; a ticket →
     `runFile`. All run at once; the pool decides who sends.
  5. When all settle: `files` = one `FileOutcome` per entry, in order; `error` = the first non-done outcome's error
     (ruling P3) or `null`.
  Files of the job are independent: one failing never stops another (spec §4.6).
- [ ] **Step 6: The client.** `client.ts` adds `start` and the two `upload` overloads. `upload` with a `File` (or
  anything that is not a list, so bad input keeps its message) returns `job.done` reduced to the file's `Result`: data
  null → the job's `{ data: null, error }`; outcome done → `ok(result)`; otherwise `fail(outcome.error)`. With a list it
  returns `job.done`. Export the types of `types.ts` from `client.ts`; `UploadOptions` stays.
- [ ] **Step 7: Tests** (`job.test.ts`, fixture as in `upload.test.ts`, `Math.random` mocked to 0). Contract: spec
  §2.2, §4.4, §4.6, rulings P2, P3, P5. Rows (exact expected values):
  1. Three small files in one `start()`: `fixture.requests` holds one `POST /upload`, three `PUT object` and three
     `POST /complete`; `done` is `{ data: { files: [3 × { id, name, status: "done", result }] }, error: null }` with ids
     `"1"`, `"2"`, `"3"`, and each stored object equals its file.
  2. The route rejects the second file (too large for `notes`, `maxSize: 16`): the first and third are done, the
     second `failed` with `FILE_TOO_LARGE`, and `error` is that error with `error.file` `{ id: "2", name }`.
  3. The bucket refuses one file's PUT with `400` (fault on `PUT object` nth 2): that file `failed` with
     `UPLOAD_REJECTED` and `error.file`, the other done; a background `POST /abort` follows for the failed one only.
  4. `/upload` refused (`UNAUTHORIZED`, signed out): `{ data: null, error }` with `error.file` undefined, and no PUT.
  5. More files than the route's `maxFiles` (add a route with `maxFiles: 2`, send 3): `{ data: null, error }` with code
     `TOO_MANY_FILES`; one `POST /upload`, nothing else.
  6. The job's signal fires during the PUTs: every file `aborted`, `error.code` `ABORTED`, an awaited `POST /abort` per
     file.
  7. `job.files[1].abort()` while its PUT is held (fault that awaits a promise the test controls): that file `aborted`,
     the others done.
  8. Ids continue across jobs of one client: a second `start()` gets id `"4"`.
  `types.test.ts`: `start()` returns `UploadJob<RouteResult<…>>`; `upload(route, [file])` returns
  `Promise<UploadResult<…>>`; `upload(route, file)` still returns `Promise<Result<CompleteResponse<…>>>`; a route with
  required metadata requires it in `start()` too.
  Existing `upload.test.ts`, `upload-failures.test.ts`, `upload-abort.test.ts` must pass unchanged; one that compares a
  whole error object may need `error.file` added; say which in the report.
- [ ] **Step 8: Run** `bun run verify` → PASS; `bun run test:browser` → 6/6.
- [ ] **Step 9: Commit** `feat(client): upload several files in one job with a result per file`.

---

### Task 5: The snapshot

**Files:**
- Modify: `packages/cloudrop/src/client/upload.ts` (`Entry` gains `progress`, `meter`; the `put` wrapper reports
  bytes), `job.ts` (store, `subscribe`, `getSnapshot`), `types.ts` (`FileSnapshot`, `JobSnapshot`, `UploadJob`
  members), `client/types.test.ts`
- Create: `packages/cloudrop/src/client/snapshot.ts` (building the snapshot from entries) and `snapshot.test.ts` if
  `job.ts` would pass about 220 lines; otherwise the builder stays in `job.ts` and its rows in `job.test.ts`

**Interfaces:**
- Consumes: `createProgress`, `createMeter`, `createStore` (Task 2); `Entry`, `startJob` (Task 4).
- Produces:
  ```ts
  // client/types.ts
  export interface FileSnapshot<R> {
    id: string; name: string; size: number; type: string; status: FileStatus;
    bytes: number; progress: number; speed: number; eta: number | null;
    error: CloudropError | null; result: CompleteResponse<R> | null;
  }
  export interface JobSnapshot<R> {
    files: readonly FileSnapshot<R>[];
    totals: { bytes: number; size: number; progress: number; speed: number; eta: number | null;
              done: number; failed: number; aborted: number; count: number };
  }
  // UploadJob<R> gains:
  subscribe(listener: () => void): () => void;   // arrow functions: no `this`, for useSyncExternalStore
  getSnapshot(): JobSnapshot<R>;
  // Entry gains: readonly progress: Progress; readonly meter: Meter;
  ```

- [ ] **Step 1: Bytes.** The `put` wrapper passes `onBytes = (sent) => { const added = entry.progress.sent(partNumber,
  sent, body.size); if (added > 0) { entry.meter.add(added, Date.now()); entry.changed(false); } }`. When the status
  turns `uploading`, `entry.meter.restart(Date.now())`.
- [ ] **Step 2: The builder.** For each entry at `now = Date.now()`: `bytes` = `size` when done, else
  `progress.bytes`; `speed` = `meter.speed(now)` while `uploading`, else 0; `progress` = `bytes / size`, or for a
  zero-byte file 1 when done and 0 otherwise; `eta` = `(size − bytes) / speed` when `speed > 0`, else `null`. Totals sum
  `bytes`, `size` and `speed`, compute `progress` and `eta` the same way from the sums, and count `done`, `failed`,
  `aborted` and `count`. New objects on every build; the store caches them.
- [ ] **Step 3: The store in the job.** `createStore(build, () => entries.some((e) => e.status === "uploading"))`;
  `entry.changed` is `store.changed`. `subscribe` and `getSnapshot` are arrow functions. A job refused before any file
  ran has a snapshot whose files carry their final status.
- [ ] **Step 4: Tests.** Contract: spec §2.1, §4.2, §4.3, rulings P7, P8. Use the fake XHR held (`fakeXhr(fixture.fetch,
  { hold: true })`, both globals stubbed) and fake timers (`vi.useFakeTimers({ toFake: ["setTimeout",
  "clearTimeout", "Date"] })`; restore in `afterEach`). Rows:
  1. A 1000-byte file: snapshots after `progress(400)` (and 100 ms) show `{ status: "uploading", bytes: 400, progress:
     0.4 }`; after `finish()` and `done`, `{ status: "done", bytes: 1000, progress: 1, speed: 0, eta: null, result }`.
  2. Bytes never decrease across a re-sent part: a 3-part file (`multipartThreshold: "8MB"`, 8 MiB × 2 + 1000 bytes);
     part 1 reports 4 MiB, then `fail()`s; its retry reports 1 MiB, then 5 MiB → the file's `bytes` read 4 MiB, 4 MiB,
     5 MiB (the retry happens after the retry wait: advance timers; `Math.random` mocked to 0 makes the wait 0).
  3. Throttle: ten `progress` events within 50 ms call a listener once (after 100 ms); a status change calls it at once.
  4. Speed and ETA: a 10 000-byte file, `restart` at the slot (t = 0), `progress(1000)` at t = 1000 ms and
     `progress(2000)` at t = 2000 ms → the snapshot at t = 2000 shows `speed` ≈ 486.58 and `eta` ≈ 16.44
     (`toBeCloseTo(…, 1)`). These are the meter's hand-worked values: 2000 bytes after two 1000-byte seconds.
  5. Totals of two files (one done 1000 bytes, one uploading 400 of 1000): `{ bytes: 1400, size: 2000, progress: 0.7,
     done: 1, failed: 0, aborted: 0, count: 2 }`.
  6. `getSnapshot()` returns the same object between two publishes (`toBe`).
  7. A listener that throws does not stop the job: `done` resolves done.
  `types.test.ts`: `getSnapshot().files[0].result` is `CompleteResponse<RouteResult<…>> | null`.
- [ ] **Step 5: Run** `bun run verify` → PASS.
- [ ] **Step 6: Commit** `feat(client): report each file's bytes, speed and time left`.

---

### Task 6: Pause, resume and abort

**Files:**
- Modify: `packages/cloudrop/src/client/upload.ts` (`Entry` gains `pass`, `wake`, `landed`; `runFile` loops over
  passes), `job.ts` (handles and job-level `pause`, `resume`), `types.ts`
- Create: `packages/cloudrop/src/client/pause.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces:
  ```ts
  export interface FileHandle { readonly id: string; readonly name: string; pause(): void; resume(): void; abort(): void }
  // UploadJob<R> gains pause(): void; resume(): void   (every file that can take them; settled files ignore them)
  // Entry gains:
  pass: AbortController | null;      // the current sending pass; pause() aborts it
  wake: (() => void) | null;         // resume() calls it
  readonly landed: Set<number>;      // part numbers stored (1 for a single PUT)
  ```

- [ ] **Step 1: Write the failing tests** (`pause.test.ts`, fake XHR held). Contract: spec §4.5, ruling P4. Rows:
  1. Pause a 3-part file with parts 1 and 2 open and part 1 already stored (finish part 1, then pause): the open PUTs
     are aborted (the fake's `open` is empty), status `paused`, `bytes` unchanged; `resume()` → the next PUTs are
     parts 2 and 3 only (`fixture.requests` shows no second `PUT part 1`), and the file ends done.
  2. Pause and resume a single PUT: the PUT is aborted, resumed from the start, `bytes` never goes below what it
     reached, the file ends done with the stored bytes equal to the file.
  3. Abort a paused file: status `aborted`, a `POST /abort` is sent and awaited before `done` resolves.
  4. Pause during `/complete` (fault that holds `/complete`): `pause()` does nothing; the file ends done.
  5. A file paused before `/upload` answers (fault holds `/upload`): it waits paused, sends no PUT until `resume()`.
  6. `job.pause()` pauses every queued or uploading file and leaves done files done; `job.resume()` resumes them; the
     job's `done` resolves once with every file done.
  7. Pause and resume on a settled file change nothing (`getSnapshot()` stays the same object).
- [ ] **Step 2: Implement.** `runFile` becomes a loop over passes:
  ```ts
  for (;;) {
    if (entry.cancel.signal.aborted) return end(aborted());                      // keep-or-abort, /abort awaited
    if (entry.status === "paused") { await resumed(entry); continue; }           // resolves on wake() or cancel
    const pass = new AbortController();
    entry.pass = pass;
    const signal = AbortSignal.any([entry.cancel.signal, pass.signal]);
    const sent = await sendAndComplete(context, entry, ticket, signal);
    if (!sent.result.error) return end(null, sent.result.data);
    if (pass.signal.aborted && !entry.cancel.signal.aborted) continue;            // paused: try again after resume()
    return end(sent.result.error);                                               // failed, or aborted by cancel
  }
  ```
  `mayBeComplete` moves onto the run (a variable outside the loop) so it stays sticky across passes. Each round of
  `sendAndComplete` sends the parts that are not in `entry.landed` (the `put` wrapper adds a part when it is stored);
  a `PARTS_MISSING` answer deletes the named parts from `landed` before the next round. If `sendParts` returns success
  but the pass was aborted meanwhile, return as paused before `/complete` (the next pass sends nothing and completes).
  `/complete` keeps `withRetry(complete, entry.cancel.signal)`, never the pass's signal.
  `pause(entry)`: only from `queued` or `uploading` → `paused`, `changed(true)`, `entry.pass?.abort()`.
  `resume(entry)`: only from `paused` → `queued`, `changed(true)`, `entry.wake?.()`.
- [ ] **Step 3: Run** `bun run verify` → PASS; `bun run test:browser` → 6/6.
- [ ] **Step 4: Commit** `feat(client): pause, resume and cancel each file or the whole job`.

---

### Task 7: The lab, the example and the browser rows

**Files:**
- Modify: `examples/next/app/lab/page.tsx`, `lab-fetch.ts`, `file-source.tsx`, `run-summary.tsx`, `run-report.ts`,
  `lab.module.css`, `examples/next/app/lab.browser.test.ts`, `examples/next/README.md`
- Create: `examples/next/app/lab/lab-xhr.ts` (the XHR wrapper), `examples/next/app/lab/file-rows.tsx` (one row per
  file: bar, bytes, speed, ETA, status, pause/resume/cancel)

**Interfaces:**
- Consumes: `createCloudropClient`, `client.start`, `UploadJob`, `JobSnapshot`, `FileSnapshot` from `cloudrop/client`.
- Produces: the lab page, which is a demo, not a library surface.

Requirements (the implementer designs the components; spec §6, third bullet):

- [ ] **Step 1: Transport.** The lab no longer passes `fetch` by default. For the length of a run it installs two
  wrappers and removes them when the run ends: `window.fetch` (the endpoints; the existing `createLabFetch` logic,
  recording and the `endpoint503` and `dropComplete` faults) and `window.XMLHttpRequest` (bucket PUTs: a subclass that
  records each PUT as a `RequestRecord`, applies the `delayMs` fault before the real `send`, and for
  `bucketNetworkError` dispatches an `error` event instead of sending; `abort()` during the delay dispatches `abort`).
  A checkbox "Send PUTs with fetch (no progress while sending)" passes the lab's fetch as the client's `fetch` option
  instead, to show spec §4.1's difference. Never record or show a URL, header or body.
- [ ] **Step 2: Several files.** The file source keeps its generated test files and the file input (now `multiple`);
  chosen files form a list; Upload starts one job for all of them (`client.start("files", files, { signal })`).
- [ ] **Step 3: Progress.** A row per file from `job.getSnapshot()` (through `useSyncExternalStore`): a `<progress>`
  with `aria-label` `Progress of <name>` and `value`/`max` in bytes, bytes sent, speed (MiB/s), ETA (s), status, and
  Pause, Resume and Cancel buttons. A totals row, and "Connections: 4" (the client's `concurrency`). Job-level Pause,
  Resume and Cancel. Keep the request table and the run summary; the summary's "completed" status line stays, so the
  existing tests keep their anchor.
- [ ] **Step 4: Browser rows** in `lab.browser.test.ts` (the three existing tests must still pass):
  1. "progress rises while a file uploads and ends at its size": throttle uploads with a CDP session
     (`Network.emulateNetworkConditions`, `uploadThroughput` 8 MiB/s, `downloadThroughput` −1, `latency` 0), upload
     the 20 MiB test file, sample the progress bar's `value` with `expect.poll` until the run completes; the samples
     never decrease, at least three are strictly between 0 and 20 971 520, and the last equals 20 971 520. If Chromium's
     throttling turns out not to slow XHR uploads (no intermediate sample), STOP and report instead of loosening the
     assertion.
  2. "a paused multipart file resumes and completes": `delayMs` 2000, upload 20 MiB, pause while the first PUTs wait,
     clear the delay, resume; the run completes, the request table shows cancelled PUTs before the stored ones, and no
     part is stored twice.
  3. "three files in one job": generate three files (for example 1 KiB, 1 MiB, 20 MiB); the table shows one `/upload`
     and three `/complete`; all three rows end done.
- [ ] **Step 5: Run** `bun run verify`, `bun run test:browser` (all rows), then
  `CLOUDROP_R2_ENV_FILE=~/.config/cloudrop/live-r2.env bun run test:browser:live` (all rows on R2; the lane deletes what
  it wrote). Update `examples/next/README.md`'s lab section (wrap at 120 columns, and fix line 59, which runs to 140).
- [ ] **Step 6: Commit** `feat(examples): show progress, pause and several files in the lab`.

---

### Task 8: Budget, decisions and docs

**Files:**
- Modify: `scripts/size-limit.config.ts`, `README.md`, `docs/superpowers/specs/2026-11-15-cloudrop-design.md` (§1),
  `docs/superpowers/specs/2026-11-16-progress-scheduler-design.md` (status line, the 123-column table line),
  `docs/decisions/README.md`, `AGENTS.md`, `docs/superpowers/plans/README.md`
- Create: `docs/decisions/m3-uploader.md`

- [ ] **Step 1: Budget.** `bun run build`, then `bun run package:check` prints the `cloudrop/client` size. Set its limit
  to the measured size plus about 10 %, rounded up to 0.1 kB, with a comment naming plan A and the owner's 7.5 kB
  ceiling (spec §7). If the measured size is above 6.5 kB, STOP and report: plan B needs the room.
- [ ] **Step 2: Decisions.** `docs/decisions/m3-uploader.md`, series `M3-U`, in the format of `m3-slice.md` (what was
  decided, why, what it costs if wrong, status). Entries: `UploadResult` departs from `Result<T>` and `error.file`
  (spec §2.2); the snapshot contract and its throttle (P7, P8); XHR versus fetch (spec §4.1, P6); the pool, its default
  of 4 and its order (spec §4.4, P9); the budget; rulings P1 to P5; every ruling the execution ledger records for this
  plan. Note that the failed-file rule amending `M3-S15` and the part-size outcome come with plan B. Add the series row
  to `docs/decisions/README.md` and `M3-U` to the series list in `AGENTS.md`.
- [ ] **Step 3: Docs.** `README.md`: the job API (`start`, the snapshot, pause, resume, cancel, several files and
  `UploadResult`), what changes when `fetch` is passed, `concurrency`; replace the "No stall detection yet" limitation
  wording only if still true (it is: stalls are plan B). Design spec §1: "Client plus React under about 8 kB gzip"
  becomes about 10 kB (owner decision 2026-11-16) and a line that `upload()` of several files returns a result per file
  with the first error (`M3-U`). The new spec's status line: approved, plan A executed at the final commit.
  `docs/superpowers/plans/README.md`: plan A done, plan B next.
- [ ] **Step 4: Run** `bun run verify` → PASS.
- [ ] **Step 5: Commit** `docs: record the uploader decisions, the job API and the client budget`.

---

## Self-review

- Spec coverage: §2 API → Tasks 4, 5, 6 (no `retry`, plan B); §2.1 snapshot → Tasks 2, 5; §2.2 results → Task 4;
  §3 modules → all (`lifecycle.ts` is plan B); §4.1 → Task 1; §4.2, §4.3 → Tasks 2, 5; §4.4 fixed pool and
  `TOO_MANY_FILES` → Tasks 3, 4 (auto and smallest-first, plan B); §4.5 → Task 6; §4.6 file independence → Task 4
  (stalls and offline, plan B); §4.7, §5 → plan B; §6 unit rows → Tasks 1 to 6, browser and `/lab` → Task 7; §7 →
  Task 8; §9 → rulings P1 and the pool numbers (plan B).
- Types: `PutObject` (Task 1) is used by Task 3's wrapper; `Entry` grows in Tasks 4, 5, 6 with the names listed in each
  Interfaces block; `UploadJob` grows the same way.
