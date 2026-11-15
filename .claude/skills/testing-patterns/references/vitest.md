# Vitest 5.1.0 notes

Only what matters for this repository. Markers: **[V]** run on Vitest 5.1.0 on 2026-11-15, **[T]** read from the 5.1.0
type declarations (`vitest/dist/chunks/*.d.ts`), **[U]** unverified: expected from Vitest's docs or habit, not
checked here. Re-check [V] and [T] lines after a Vitest upgrade. Tests run on Node; Bun only starts the scripts.

## Lanes by config

- Lanes are Vitest `projects` with their own `include`/`exclude` (see repository.md); `--project <name>` picks one.
  [V: a config whose `include` matched only the integration file ran it and not the unit file; the `projects` form
  and `--project` are unverified here, they come from the repo's config.]
- With no matching files Vitest exits 1 unless `passWithNoTests` is set [V]. The unit script sets it so the lane is
  green before the first test exists; backend lane scripts must not, so an empty lane never looks green.
- A throwing `beforeAll` fails the file and the run exits 1 [V]; its tests are counted as skipped in the summary,
  but the run is red. This is how a backend lane fails with "set X to run this lane".
- Do not set `retry` (default 0) [T]. `allowOnly` defaults to `!process.env.CI` [T], so a stray `.only` is
  accepted locally; never commit one.

## Skipping, only as the contract suite does it

- `ctx.skip(reason)` takes the test context's first parameter: `test("...", (ctx) => { ctx.skip("RustFS has no
  object lock") })` [V]. The reason shows in the verbose report [V].
- It works by throwing, so never wrap it in `try/catch` [T: "This function throws an error"]. `ctx.skip(condition,
  reason)` skips only when the condition is true [T].
- Not allowed elsewhere: no `test.skip`, `test.skipIf` or `describe.skipIf` for a missing service.

## Table tests and assertions

- `test.each([{ name, ... }])("title $name", ...)` interpolates object keys in the title [V].
- `expect.assertions(n)` fails a test that made a different number of assertions [V]. Use it for async rejection
  tests that could otherwise pass without reaching their assertion.
- `await expect(p).rejects.toThrow(...)` is the plain form; always `await` it.

## Timers and doubles

- `vi.useFakeTimers()` also moves `Date.now()`; `vi.setSystemTime` and `vi.advanceTimersByTime` work as expected [V].
  Call `vi.useRealTimers()` in `afterEach` so fake time cannot leak into the next test.
- `restoreMocks`, `unstubGlobals` and `unstubEnvs` exist and default to `false` [T]. Without them you restore by hand.
- Prefer injecting `fetch` and `now` over any module mock. `vi.mock` is hoisted above imports [U] and is for
  boundaries we do not own only.

## Measuring speed

- `vitest run --reporter=verbose` prints each test's duration [V]. `slowTestThreshold` defaults to 300 ms [T].
- `--reporter=json` and `--reporter=junit` wrote a file under `.vitest/` instead of stdout when no output file was
  given [V]; pass `--outputFile` for a chosen path [U].
