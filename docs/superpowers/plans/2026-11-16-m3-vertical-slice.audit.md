# Audit: M3 vertical slice plan

> **Status (2026-11-16): closed.** Its findings were ruled in `M3-H13` to `M3-H16` and applied to the plan before it
> executed. Where the project stands now: [`README.md`](README.md).

Plan: [`2026-11-16-m3-vertical-slice.md`](2026-11-16-m3-vertical-slice.md) (1,578 lines, 11 tasks, S1 to S26, U1 to
U14). Audited 2026-11-16 on `feat/hardening` at `f946826` (lane I merged), against the design spec (§1, §3, §5, §6, §7,
§9, §11, §12), `docs/decisions/` (M3-O1 to M3-O4 and the cited M2 rulings), `AGENTS.md`, the `testing-patterns` and
`code-quality` skills, the three evidence documents and the server code the client talks to. Two controller rulings
made after the plan revision were audited like any other decision: (a) "all wire types" in M3-O1 means the request and
response shapes of the four endpoints, the error body and the route inference types a client user annotates with, and
leaves out the protocol constants, `RequestHandler`, the client's internal fetch type and `CloudropErrorOptions`;
(b) the example creates the server when its module loads, so `next build` needs the storage settings and
`CLOUDROP_SECRET` (S21).

Verdict: **executable after the fixes below.** One Critical (a late cancel deletes a file whose `onComplete` already
ran), four Important. No finding needs a task moved or the slice re-planned.

The audit changed no repository file except this one. No backend lane, browser or live R2 was run.

## What was verified independently

Scratch work lived in `~/projects/.worktrees/cloudrop/scratch-m3-audit/` and was deleted afterwards. Compiles used the
repository's `tsc` 7.0.2 (`packages/cloudrop/node_modules/.bin/tsc`) with the package's compiler options and the real
`src/` modules imported by path; Node 24.22.2 for the rest.

| Claim | How | Result |
|---|---|---|
| Base for execution | `git merge --ff-only feat/hardening`; `git log -1` | `f946826`. `grep -n fileId src/protocol/types.ts` prints nothing (lane I merged, M3-O2 holds) |
| Unit-lane baseline (Task 1 step 1) | `bun run test` on Node 24 | **896 passed, 1 skipped**, 50 files, 727 ms. Use this N |
| Every `file:line` in the plan | Read each cited range | All hold except four stale numbers (M-3). The S6 importer list is exact: nine server modules and four `storage/s3` modules import the two helpers; after the move four server modules still import `validate.ts` |
| Wire shapes, codes, statuses, messages | `protocol/types.ts`, `server/http.ts`, the endpoint modules | Every shape in Task 4's "Shapes" list matches. `FILE_TOO_LARGE` text, `storageBusy`/`storageDown` wording (`http.ts:78`, `:83`), Wrangler's `502` body (`storageFailure` of a non-retryable 501), `PARTS_MISSING` 409 with `parts`, `/sign`'s part-list rule, `If-None-Match` on single PUTs (`presign.ts:53`) all as the plan says |
| Client type contract (S2, S3; Task 7 type table) | The plan's `UploadOptions`, `UploadArguments`, `CloudropClient`, `createCloudropClient` declarations compiled against a real `createCloudrop` | Every row holds **except** the schemaless result when routes are written inline: `Result<CompleteResponse<unknown>>`, not `<null>` (I-2). A second probe isolated it: `RouteResult` of an inline route without `onComplete` is `unknown`; the same route assigned to a constant first is `null`. `NoInfer<…>` around `route()`'s return type fixes it with the real return type; both probes then pass, and the existing `server/types.test.ts` shapes (`Route<undefined, null>` for a void `onComplete`, `Route<undefined, { id: string }>` for an async one) stay equal under `NoInfer` |
| Task 2 status table | Probe with the plan's `ServerErrorCode`, `satisfies` and type guard | Typecheck passes; `ABORTED: 499` in `STATUS` gives `TS2353 … 'ABORTED' does not exist in type 'Record<ServerErrorCode, number>'`, as step 3 expects |
| U7: Biome restricted-import patterns (S19) | Scratch project, Biome 2.6.8, the plan's override | **Settled.** The override reports `../storage/…`, `./storage/…` (from `client.ts`), `../../storage/…` and an `import type` of `../server/…`, and skips `*.test.ts`. `["**/storage/**", "**/server/**"]` alone matches all four (M-4) |
| U8: `@size-limit/esbuild` and the existing budgets (S20) | Read `size-limit@14.3.0` (`get-config.js`, `calc.js`) and the packed `@size-limit/esbuild@14.3.0` (`index.js`) | **Settled from code, not run:** once installed, the plugin bundles every check (`step20`/`step40` skip only `check.esbuild === false`, and `esbuild` is not an accepted option key, so it cannot be set). The three existing figures will change and Task 7 step 4 stops every time (I-3). Per-check `disablePlugins` is accepted and honoured (`calc.js:1-3`) |
| basePath regex (S17, Task 6) | Node | Accepts `/api/cloudrop` and `https://api.example.com/api/cloudrop`; refuses all four of the plan's bad inputs, `/`, a bare origin, `//evil.com/api` and a fragment. Accepts `/api/./cloudrop` (harmless: `fetch` normalises it) |
| Demo cookie regex, S3 code regex | Node | `demo-user=demo` found alone, after another cookie and before one; `xdemo-user=` and upper case refused; `<Code>SignatureDoesNotMatch</Code>` read |
| Retry arithmetic (Task 3 rows) | By hand from the plan's `retryDelay` | 250, 1000, 10000, 3000, 20000 as the table says |
| Biome on the example | Scratch file | A `<button>` without `type` is an error (`a11y/useButtonType`); an unused import is a warning only (M-1, M-9) |
| Measurements cited for browser, RustFS, Wrangler, Next | `2026-11-16-m3-slice-measurements.md` §1 to §4 | Every claim the plan marks as measured is in the document. Not measured and correctly listed: U1, U3, U10 on R2; U2 on R2; U6 for `cloudrop/client` in a client component; U11; U12; U13; U14 |
| Client import graph | Read `plan.ts`, `rules.ts`, `input.ts` (planned), `protocol/types.ts`, `errors.ts` | No path to `storage/` or `server/`: `plan.ts` imports `rules.ts` only, `rules.ts` nothing, `protocol/types.ts` a type from `errors.ts`, `errors.ts` nothing |
| Decision ids | `grep` in `docs/decisions/` | M2-X1, M2-X27, M2-X35, M2-X38, M2-D17, M2-D27, M2-D28, M3-O1 to M3-O4, M3-H8 resolve. The README has no series for M3 plan decisions yet (M-11) |
| `/abort` against the server | `server/abort.ts`, spec §5.5 | A live token deletes this upload's own object even after `/complete` (`abort.ts:23-31`). The plan's cancel rule does not account for a `/complete` in flight (C-1) |

## Task 1: The neutral input module

### M-1 Minor: `validate.ts` keeps an unused `CloudropError` import

Plan lines 442 to 445. After `invalidInput` moves out, `storage/validate.ts:1` imports `CloudropError` for nothing
(lines 1, 10 and 11 are its only uses). Biome reports `correctness/noUnusedImports` as a warning, so `bun run check`
passes and the warning stays.

Replace step 3's first sentence with: "Delete them from `validate.ts`, replace its `import { CloudropError } from
"../errors.ts";` with `import { isPlainObject } from "../input.ts";` (nothing else in the file uses `CloudropError`)."

## Task 2: Client error codes

No finding. The probe above confirms steps 2 and 3. `handler-failures.test.ts` is 110 lines.

## Task 3: Retry, bucket answers and the client's errors

### M-2 Minor: `endpoints.ts` is created here but not listed

Plan lines 497 to 499 and 538 to 539. Task 3 creates `src/client/endpoints.ts` (for `ClientFetch`) without naming it
under **Files**, and Task 4 says "extend the file from Task 3". Add to Task 3's **Files**: "Create:
`packages/cloudrop/src/client/endpoints.ts` (only `ClientFetch`; Task 4 fills it)."

## Task 4: Talking to the server

### Change required by C-1

`Endpoints.complete` loses its signal (C-1). Replace plan line 645-646 with:

```ts
  /** POST /complete { token }, without the caller's signal: a cancel must not cut off a /complete the server may finish. */
  complete(token: string): Promise<Result<CompleteResponse<unknown>>>;
```

and in "Rules for `endpoints.ts`" (line 681-682) replace "`credentials: "include"` and the signal" with
"`credentials: "include"` and the signal (`complete` and `abort` send none)".

### M-5 Minor: `/abort` can hold a cancelled `upload()` open indefinitely

Plan lines 647-648 and 1034. The cancelled call awaits `/abort` with no signal and no bound, so a server that never
answers keeps `upload()` pending after the user cancelled. Replace line 647-648 with:

```ts
  /** POST /abort { token }, once; never rejects, gives up after ABORT_TIMEOUT_MS (10 s); the answer ({ id }) is ignored. */
  abort(token: string): Promise<void>;
```

with `const ABORT_TIMEOUT_MS = 10_000;` and `signal: AbortSignal.timeout(ABORT_TIMEOUT_MS)` on that one fetch, and
`catch` around it. No new test: the cancel rows already show `/abort` is sent.

## Task 5: Sending parts

### M-6 Minor: the "stops when the upload is cancelled" row cannot pass against the plan's own code

Plan lines 832 to 846 and row line 887. `sendPart` checks the signal only at the top of the loop, before `await
urlFor(…)`. All four workers reach that `await` in the same synchronous pass, so if the double aborts inside the first
`put`, the next three continuations call `put` with an aborted signal: the row "no `sign` or `put` starts afterwards"
fails. In production the cost is three `fetch` calls that reject at once, but the row is specified to go red.

Replace in `sendPart`:

```ts
    const target = await urlFor(run, partNumber, renew);
    const outcome = target.error ? signFailure(target.error) : await run.sender.put(target.data, partNumber);
```

with

```ts
    const target = await urlFor(run, partNumber, renew);
    // urlFor may have waited for a /sign; the upload may have been cancelled meanwhile.
    if (run.sender.signal.aborted) return aborted();
    const outcome = target.error ? signFailure(target.error) : await run.sender.put(target.data, partNumber);
```

and add to step 4's fault probes: "drop the signal check after `urlFor` (the cancel row fails: three more `put`
calls)."

### M-7 Minor: one row pins microtask order

Row line 884 expects exactly parts 1 to 5 put. That count follows from the double resolving each `put` one microtask
after it starts and from `urlFor` returning after one tick; an extra `await` anywhere changes it to 1 to 4 or 1 to 6
without any contract change (anti-slop A4). Keep the row, because it is the only one that catches `failure ??= await`,
but assert `put` calls ⊆ parts 1 to 5 and none of 6 to 10, and add a comment naming the bug it guards.

## Task 6: `upload()` and the `cloudrop/client` entry

### C-1 Critical: a cancel during `/complete` deletes a file whose `onComplete` already ran

Plan lines 243 to 247 (S14), 1000 to 1036 (`sendAndComplete`, `uploadFile`), 1075 to 1088 (`upload-failures` rows) and
416 (threat row).

What is wrong. `sendAndComplete` passes the caller's `signal` to `/complete` (line 1011). The server needs several
storage round trips there (ListParts, CompleteMultipartUpload, HEAD) and then runs `afterVerify` and `onComplete`
(`server/complete.ts:135-185`). If the user cancels while that request is in flight:

1. the browser aborts the `fetch`, `endpoints.complete` returns `aborted()`, `withRetry` returns it;
2. `uploadFile` sees `result.error && signal.aborted` (line 1033) and sends `/abort` with the still-valid token;
3. the server may already have completed the upload and run `onComplete` (the app recorded the file, say, as the
   user's avatar). `/abort` then finds the object by its `cloudrop-id`, deletes it and runs `onAbort` with
   `reason: "aborted"` (`server/abort.ts:23-33`; spec §5.5: "any live token can delete its own completed object").

The app is left with a record pointing at a deleted object, and nothing reports it: the client says `ABORTED`, the
server logs nothing. The plan's comment "A completed upload stays completed" (line 1032) covers only a success the
client saw. The window is the whole `/complete` call, which for a large multipart upload is seconds, exactly when a
user watching a stalled-looking bar clicks cancel. No row tests a cancel during `/complete`.

Replacement.

S14 (lines 243-247), replace with:

> **S14 Cancellation.** `options.signal` reaches every `fetch` except `/complete` and `/abort`, and every backoff pause.
> A signal already aborted at the call starts no request. A cancel stops the upload before the next request starts;
> `/complete` runs without the signal, because the server may finish it (and run `onComplete`) after the browser gave
> up waiting, and `/abort` with a live token would then delete a recorded file (ruling M2-X1, `server/abort.ts:23-31`).
> After a cancel the client returns `ABORTED` and sends one `POST /abort { token }` (bounded by 10 s, answer ignored)
> unless the last `/complete` got no answer: then the file may be complete, and it is kept. A `/complete` that succeeds
> is returned as a success even when the signal fired meanwhile. Cancelling during `/upload` loses the token: the
> multipart upload (if any) waits for the lifecycle rule and a plugin's reservation for its expiry (M2-X27). A single
> PUT cancelled after its bytes reached the bucket may land after `/abort`'s HEAD; that object is an orphan the
> lifecycle rule does not remove (the 1.1 adapters close it).

`upload.ts`, replace `sendAndComplete` and the tail of `uploadFile` (plan lines 1000-1016 and 1031-1035) with:

```ts
interface Sent {
  result: Result<CompleteResponse<unknown>>;
  /** The last /complete got no answer, so the server may have completed the file: a cancel keeps it. */
  mayBeComplete: boolean;
}

async function sendAndComplete(context: UploadContext, ticket: Ticket, file: File, signal: AbortSignal): Promise<Sent> {
  const sender = senderFor(context, ticket, file, signal);
  let parts = Array.from({ length: ticket.kind === "single" ? 1 : ticket.partCount }, (_, index) => index + 1);
  let mayBeComplete = false;
  const complete = async (): Promise<Result<CompleteResponse<unknown>>> => {
    const done = await context.endpoints.complete(ticket.token);
    mayBeComplete = done.error?.code === "NETWORK_ERROR";
    return done;
  };
  for (let round = 0; ; round++) {
    const sent = await sendParts(sender, parts);
    if (sent.error) return { result: fail(sent.error), mayBeComplete: false };
    const done = await withRetry(complete, signal);
    const missing = done.error?.code === "PARTS_MISSING" ? done.error.parts : undefined;
    if (!missing?.length || round === REPAIR_ROUNDS) return { result: done, mayBeComplete };
    parts = [...missing];
  }
}
```

```ts
  const { result, mayBeComplete } = await sendAndComplete(context, started.data, file as File, signal);
  // A completed upload stays completed: /abort with a live token would delete it (ruling M2-X1).
  if (!result.error || !signal.aborted) return result;
  if (!mayBeComplete) await context.endpoints.abort(started.data.token);
  return fail(aborted());
```

`withRetry` already checks the signal before each attempt and in its pause, so a cancel during the backoff after an
answered `/complete` error still ends in `/abort`.

Add to `upload-failures.test.ts` (after the "cancels a multipart upload…" row):

| Name | Fault | Expected requests | Result |
|---|---|---|---|
| keeps a file whose /complete finished while the upload was cancelled | `POST /complete`: forward, abort the controller, return the forwarded answer | upload, PUT, complete; no `/abort` | success with the route's `data`; `fixture.server.storage.head(key)` finds the object |
| keeps a file whose /complete answer was lost to a cancel | `POST /complete`: forward, abort the controller, then throw `TypeError` | upload, PUT, complete; no `/abort` | `ABORTED`; the object exists |
| cleans up after a cancel during a /complete the server refused | first `POST /complete`: abort the controller, answer 503 `SERVER_ERROR` retryable without forwarding | upload, PUT, complete, abort | `ABORTED`; `head(key)` is `null` |

Oracle: the stored object and the request list, from the real handler on the fake. Bug caught: the signal reaching
`/complete`, or `/abort` after an unanswered `/complete`. Step 4 gains the fault probe "pass `signal` to
`endpoints.complete` again: the first row fails (an `/abort` appears and the object is gone)". Step 3's count for
`upload-failures.test.ts` becomes 12. The threat row at line 416 becomes "A cancelled upload left open, or a completed
one deleted by a late cancel | `/abort` only when no `/complete` may have succeeded; `/complete` runs without the
signal (S14) | upload-failures › cancel rows and the three /complete cancel rows".

### Change required by I-1

The export block (plan lines 910-931) gains, beside the wire types:

```ts
export type { InferableCloudrop, RouteMetadata, RouteName, RouteResult } from "./protocol/types.ts";
```

Line 907 reads "decision S4, all 31 names".

## Task 7: Publish `cloudrop/client`

### I-1 Important: the public surface leaves out the route inference types that ruling (a) puts in

Plan lines 139 to 156 (S4), 907, 1175-1177 (step 2), 1496 (Definition of done), 1532 and 1571-1575 ("Not settled"
item 1).

What is wrong. The controller's ruling (a) defines M3-O1's "all wire types" as the endpoint shapes, the error body
**and the route inference types a client user annotates with**. S4 excludes all of them (`InferableCloudrop`,
`RouteName`, `RouteMetadata`, `RouteResult`) as "type machinery", and "Not settled" still asks the owner the question
the ruling answered. A client user who writes `const route: RouteName<typeof cloudrop> = …`, a wrapper
`function send<T extends InferableCloudrop>(client: CloudropClient<T>)` or an annotation of the result type would have
to import from `cloudrop`, the server entry, which the spec tells clients never to import (§1: "The client imports only
the server's type"). `InferableCloudrop` is also the constraint of the public `CloudropClient` generic, so leaving it
out makes a public signature name a type the user cannot.

The ruling is right: the four names are already a semver promise of the root entry (`src/index.ts:2-8`), so exporting
them twice adds no new promise, and they are what a client user annotates with. `RouteTypes` and `Jsonified` stay out:
nobody annotates client code with them, and the root does not export them either (M2-X38).

Replacement for S4's list (lines 139-156):

> **S4 Public surface of `cloudrop/client` (owner decision M3-O1, scoped by the controller's ruling of 2026-11-16).**
> Exactly these 31 names, each a semver promise:
> - Values (2): `createCloudropClient`, `CloudropError`.
> - Client types (6): `ClientOptions`, `CloudropClient`, `UploadOptions`, `UploadArguments`, `Result`,
>   `CloudropErrorCode`.
> - Wire types (19): (the list as it stands).
> - Route inference types (4): `InferableCloudrop`, `RouteName`, `RouteMetadata`, `RouteResult`, the types a client
>   user annotates with; the root entry exports the same four for server code.
>
> Not exported: the constants `MAX_BODY_BYTES`, `PARTS_PER_SIGN`, `MAX_NAME_LENGTH`; `RouteTypes`, `Jsonified`,
> `RequestHandler`; `ClientFetch` (reachable as `ClientOptions["fetch"]`); `CloudropErrorOptions`. Adding one later is
> not breaking. `CloudropError` is the class the root exports (one shared chunk), so `instanceof` agrees across
> entries.

Change "27" to "31" at lines 907, 1176, 1496 and 1532. Delete "Not settled" item 1 and renumber; record ruling (a) as
an M3 entry in Task 11 step 3. Task 7's type table gains one row:

| Row | Expression | Expected |
|---|---|---|
| inference types from the client entry | `RouteName<typeof cloudrop>`, `RouteMetadata<typeof cloudrop, "avatar">`, `RouteResult<typeof cloudrop, "notes">` imported from `../client.ts` | `"avatar" \| "notes" \| "optional"`, `{ albumId: string }`, `null` |

### I-2 Important: an inline route without `onComplete` gives the client `unknown`, and the type test cannot show it

Plan lines 1126 to 1144 (type table), 1253-1293 (`lib/cloudrop.ts`); code `packages/cloudrop/src/server/route.ts:122-124`.

What is wrong (measured, see the verification table). `route()` declares `TResult = null`, but when the call is
written inside `createCloudrop({ routes: { notes: route({ … }) } })`, TypeScript infers `TResult` from the contextual
return type `Route` (`createCloudrop<TRoutes extends Record<string, Route>>`, `server/cloudrop.ts:22`), whose result
parameter defaults to `unknown`. So `RouteResult<typeof cloudrop, "notes">` is `unknown`, and
`client.upload("notes", file)` returns `Promise<Result<CompleteResponse<unknown>>>`. The same route assigned to a
constant first (as `server/types.test.ts` does) is `null`. The spec's quickstart (§1) writes routes inline, so every
user of the documented shape gets `unknown` for a route without `onComplete`. The plan's row "schemaless result"
passes or fails depending on how the implementer happens to write the fixture, and `server/types.test.ts:77-88` cannot
catch it because it defines its routes as constants.

Replacement. Task 7 **Files** gains "Modify: `packages/cloudrop/src/server/route.ts:122-124`; Test:
`packages/cloudrop/src/server/types.test.ts`". New step 1 (renumber the rest):

> **Step 1:** In `route.ts`, change the return type of `route()` to
> `NoInfer<Route<SchemaInput<TSchema>, CompleteData<Awaited<TResult>>>>` with the comment
> `// NoInfer: written inside createCloudrop({ routes }), the call would otherwise infer TResult from the expected Route
> // and type a route without onComplete as unknown, not null.` Add to `types.test.ts`, inside
> `describe("type inference for the client", …)`:
>
> ```ts
>   it("types an inline route without onComplete as null, as the quickstart writes routes", () => {
>     const inline = createCloudrop({
>       storage: r2({ bucket: "uploads", accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "k", secretAccessKey: "s" }),
>       secret: "test-secret-0123456789abcdef0123456789",
>       routes: { notes: route({ accept: "text/plain", maxSize: 1024, authorize: allowAnyone }) },
>     });
>     expectTypeOf<RouteResult<typeof inline, "notes">>().toEqualTypeOf<null>();
>   });
> ```
>
> RED first: without the `NoInfer` it fails with "Expected: null, Actual: unknown". `bun run typecheck` passes after.

In the client type table, add "Routes are written inline inside `createCloudrop({ routes })`, as spec §1 does." to the
paragraph before the table (line 1128-1130). Add an M3 decisions entry (Task 11 step 3): the route's result type no
longer follows the expected type of its position.

### I-3 Important: installing the esbuild plugin changes all three existing budgets, so step 4 always stops

Plan lines 267 to 277 (S20), 361 (U8), 1181 to 1192 (steps 4 and 5).

What is wrong (from size-limit's code, see the verification table). With `@size-limit/esbuild` installed, every check
is bundled by esbuild: the plugin skips a check only when `check.esbuild === false`, and size-limit refuses `esbuild`
as an option key. The three existing checks would then be esbuild bundles of their file lists (each chunk bundled
again as its own entry, so shared chunks count twice), not the summed gzip of the files. Step 4's stop condition fires
on every run and hands the owner a choice the tool already answers.

Replacement. U8's row: "**Settled** from `size-limit@14.3.0` and `@size-limit/esbuild@14.3.0`'s code: the plugin
applies to every check unless the check lists it in `disablePlugins`." In `scripts/size-limit.config.ts` the three
existing entries gain `disablePlugins: ["@size-limit/esbuild"]`, with the comment
`// Summed files, not a bundle: these budgets count the entry and its chunks as published.` Step 4 becomes:

> **Step 4:** Record the three existing figures (`bun run package:check`). `npm view @size-limit/esbuild@14.3.0 time`;
> `bun add -d --exact @size-limit/esbuild@14.3.0` in `packages/cloudrop`. Add `disablePlugins: ["@size-limit/esbuild"]`
> to the three existing entries. Run `bun run package:check` again: the three figures are byte-equal to the recorded
> ones. If one differs, STOP and report both sets.

Step 5 is unchanged (the client entry has no `disablePlugins`).

### M-4 Minor: the restricted-import patterns can be two, and U7 is settled

Plan lines 265-266 (S19), 360 (U7), 1160, 1178-1180. Measured (verification table): `"**/storage/**"` and
`"**/server/**"` alone match `./`, `../` and `../../` specifiers and `import type`. Replace the `group` array with
`["**/storage/**", "**/server/**"]`; mark U7 "Settled (audit, Biome 2.6.8)". Keep step 3's fault probe: it proves the
override is wired into this repository's `biome.json`.

## Task 8: The Next.js example

### M-8 Minor: lane I has landed; drop the "before lane I" branches

Plan lines 66 to 70, 312 to 313 and 1347 to 1348. At `f946826` a `501` on a CORS or lifecycle read reports `unknown`
(`server/bucket-check.ts:45`, `:82`; spec §9; `test-backends.md`, Wrangler table). Replace the "Before Task 1" bullet's
last sentence with "Landed at `f946826`: `bucket-check.ts:45` and `:82`." Delete "(before it, the whole call fails…)"
at line 312-313 and "(or, on a release before lane I, fails with `STORAGE_ERROR`)" at line 1347-1348.

### M-9 Minor: Biome refuses the planned sign-in button

Plan lines 1304 to 1309. Biome's recommended `a11y/useButtonType` is an error for a `<button>` without `type`
(measured). Add to the `app/page.tsx` paragraph: "The button has `type="button"` (Biome `a11y/useButtonType`)."

### M-10 Minor: the example is outside the file-size check

Plan lines 99 to 101 and 1372. `scripts/check-file-size.ts` lists only `packages/*/src/**/*.ts` and `scripts/**/*.ts`,
so `examples/next/**` (including `.tsx`) has no cap, contrary to "Every file in the file map is planned under 220
lines". Add to Task 8's **Modify**: "`scripts/check-file-size.ts`: add `:(glob)examples/*/**/*.ts` and
`:(glob)examples/*/**/*.tsx` to the listed paths (`.next/` is git-ignored, so `--exclude-standard` drops it)", and to
step 5: "`bun run check` now also caps the example's files."

## Task 9: The browser lane

### I-4 Important: the browser test cannot run on R2, which Task 10 needs

Plan lines 1398 to 1405 (Task 9 rows and oracle), 1436 to 1454 (Task 10).

What is wrong. Task 9 reads the stored bytes back "through the `s3()` driver with the lane's settings" and expects the
key `browser/demo/<ulid>.txt`. Task 10 runs the same file against R2 with `CLOUDROP_S3_ENDPOINT=""` and
`CLOUDROP_EXAMPLE_PREFIX=live-test/cloudrop-<32 hex>`: the test's `s3()` throws `INVALID_CONFIG` for the empty
endpoint, and the status line never starts with `browser/`. Task 10 step 2's "2 passed" cannot happen as written.

Replacement. In `lib/cloudrop.ts` (plan line 1260), export the storage: `export const storage = endpoint ? s3({…}) :
r2({…});`, with the comment `// Exported for the browser test, which reads the uploads back through the same storage.`
Replace Task 9's oracle sentence (lines 1398-1400) with: "oracle: the bytes the test created, read back through the
`storage` that `lib/cloudrop.ts` exports (RustFS in this lane, R2 in Task 10), and the request kinds the page sent". In
both rows, the expected key is `` `${process.env.CLOUDROP_EXAMPLE_PREFIX}/demo/<ulid>.<ext>` `` (the test fails when the
variable is unset, never defaults). Task 10 step 2 then holds as written.

### M-11 Minor: the lane leaves an `.env.local` pointing at a removed container

Plan lines 1328-1329 and 1389-1391. When no `.env.local` exists, `setup:rustfs` inside `scripts/test-browser.sh`
writes one with a random secret and the lane's port; the trap then removes the container, and the developer's next
`bun run dev` talks to nothing. Add to `setup-rustfs.ts` item 6: "Skips this step when `CLOUDROP_SETUP_ENV_FILE=0`."
`scripts/test-browser.sh` exports `CLOUDROP_SETUP_ENV_FILE=0` (it exports every setting itself).

### M-12 Minor: CI's `check` job never type-checks the example

Plan line 1383-1384. CI's `check` job runs the gates one by one, not `verify` (`.github/workflows/ci.yml`, job
`check`), so the example typecheck added to `verify` does not run there; only the browser job's `next build` covers
it, after a Chromium install. Add to Task 9's **Modify**: "`.github/workflows/ci.yml`, job `check`: a step
`bun run --filter cloudrop-example-next typecheck` after `bun run package:check`."

## Task 10: Live R2 from a browser

### M-13 Minor: step 3 needs an origin, not a running example

Plan lines 1455 to 1460. Step 3 opens `http://localhost:5173` "with the example started as in step 2", but step 2's
Playwright `webServer` has stopped by then, and the step does not say who starts it. The measurement needs only the
origin (the bucket's CORS rule names it). Replace "opens `http://localhost:5173` (the example started with the live
settings, as in step 2)" with "routes `http://localhost:5173/` to a blank page with `page.route(…, (route) =>
route.fulfill({ contentType: "text/html", body: "<!doctype html>" }))` and opens it, so the page has the origin the CORS
rule names without a server".

## Task 11: Documentation and decisions

### M-14 Minor: the decision entries must follow this audit

Plan lines 1480 to 1487. Step 3's "`M3-S<n>`" is a new series, which the decisions README requires to have a row in
its prefix table (`docs/decisions/README.md`, "Adding an entry"); say so in step 3. The entries also need: ruling (a)
and the 31-name surface (I-1), the `NoInfer` return type of `route()` (I-2), `/complete` without the signal and the
keep-on-unanswered rule (C-1, S14 as replaced), and the size-limit `disablePlugins` split (I-3). Step 2's §3 edit
reads: "`cloudrop/client` exports the wire types of the four endpoints and the route inference types `RouteName`,
`RouteMetadata`, `RouteResult` and `InferableCloudrop` (S4)". Add a §5.5 sentence: "The client never sends `/abort`
after a `/complete` that may have succeeded."

## Cross-task

- **M-3 Minor: stale citations.** `server/bucket-check.ts:21` (plan line 1317) is `:24` (`UPLOAD_HEADERS`);
  `bucket-check.ts:36` (line 1318) is `:39` (ETag exposed); `server/handler.ts:106-115` (line 1298) is `:107-116`.
  Correct them in the plan; the rest of the citations hold at `f946826`.
- **X-1 Minor: the threat table.** Update the cancel row (C-1, text above) and add: "A route result typed `unknown`
  for the quickstart's inline routes | `NoInfer` on `route()` (I-2) | types › 'types an inline route without onComplete
  as null…'".
- **X-2: counts.** Baseline N = 896 (1 skipped). The fixes add: Task 6 +3 (C-1 rows); Task 7 +1 runtime-free type row
  in each of `client/types.test.ts` and `server/types.test.ts` (the server one is a new `it`, so +1 test). Every other
  count stands. A changed count is not a failure.
- **X-3: every task still ends green.** I-2 adds a server type change to Task 7, before the client type tests that
  need it; no earlier task depends on it. C-1 changes `Endpoints.complete` (Task 4) and its only caller (Task 6). I-4
  changes `lib/cloudrop.ts` (Task 8) for a test written in Task 9. No fix moves work between tasks, and no task
  consumes something a later task produces.
- **X-4: file sizes and complexity.** The estimates hold with the fixes: `upload.ts` gains about 12 lines (~145),
  `parts.ts` 2, `endpoints.ts` 3; `upload-failures.test.ts` with 12 rows stays far under 400. `sendAndComplete` stays
  under complexity 15 (one loop, three branches). `src/testing/client-fixture.ts` compiles under the main
  `tsconfig.json` (`types: []`, `isolatedDeclarations`), which its explicit signatures already allow.
- **X-5: security, checked and holding.** Every client message is a fixed string or carries only an HTTP status; the
  server's messages pass through unchanged and carry no URL or token (M2). The fixture records labels, never URLs.
  Playwright's trace, video and screenshot are off; the PUT recorder keeps only method and part number. Bucket PUTs
  omit credentials; the token goes only to `basePath`. The only security defect found is C-1.
- **X-6: unverified behaviour, updated.** U7 and U8 are settled (above). New, not measured: the extra install that
  `examples/*` adds to every CI job's `bun install --frozen-lockfile` (Next with its SWC binaries, React, Playwright's
  package; no browser download), measured by Task 9's first CI run beside U13. The cancel race in C-1 is not
  observable on a real backend without a slow `/complete`; the unit rows are its proof.
- **X-7: bundle.** The client's import graph reaches no storage or server module (verification table), so the
  Definition of done's `grep -l` for `signToken`, `presignPut` and `storageError` (all three exist in server or
  storage code) is a real check. The 4 kB stop line is plausible for about 600 lines of client source; Task 7 measures
  it.

## Owner decisions

1. **Ruling (a): the surface of `cloudrop/client`.** **Recommendation:** accept it, with the 31 names of I-1: the four
   inference types are already promised by the root, and a client user needs them without importing the server
   entry. Cost if wrong: four type names the client entry can never drop without a major release; nothing at runtime.
2. **A cancel after `/complete` may have succeeded (C-1).** The fix keeps the file and returns `ABORTED` when the last
   `/complete` got no answer, so the user sees "cancelled" for a file that may exist and may be recorded by
   `onComplete`. The alternative, deleting it, risks a recorded file vanishing. **Recommendation:** keep the file; a
   recorded file without its object is worse than an object the user thinks they cancelled, and the 1.1 adapters,
   which know whether `/complete` ran, close the gap. Cost if wrong: rare orphan objects that no lifecycle rule removes.
3. **Ruling (b): the example creates the server at module load, so `next build` needs the settings.** **Recommendation:**
   accept it. A lazy getter would turn the quickstart's `typeof cloudrop` into `ReturnType<typeof getCloudrop>`, and
   `export const dynamic` does not stop Next from evaluating a route module while collecting page data (it reads that
   export from the evaluated module). Next does not inline variables without `NEXT_PUBLIC_` into browser code, and
   Task 8 step 3 checks it. Add one README sentence: a build that has no secrets (a Docker build stage with secrets only
   at run time) must pass them as build secrets or fails with `INVALID_CONFIG`. Cost if wrong: every app that follows
   the quickstart learns this at its first CI build; the fix is then a library change (deferring the setting checks to
   the first request), not an example change.
4. **I-2 changes a server type in the client slice.** **Recommendation:** fix it here: it is one return type, the
   client is its first consumer, and the package is unpublished. Cost if wrong: none at runtime; a route's result type
   no longer follows the expected type of its position, which nothing relies on.
5. **Task 10's prerequisites** (the plan's item 2, unchanged): the owner's test bucket and a confirmation that the CORS
   rule `cloudrop-browser-tests` covers `http://localhost:5173`. Without it, spec §12's open browser items stay open.

## Counts

| Severity | Count | Findings |
|---|---|---|
| Critical | 1 | C-1 |
| Important | 4 | I-1, I-2, I-3, I-4 |
| Minor | 15 | M-1 to M-14, X-1 |
| Owner decisions | 5 | listed above |
