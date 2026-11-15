---
name: testing-patterns
description: Write, review and prune cloudrop's tests under Vitest, contract-first, colocated and fast; reject AI-slop tests. Use for bug regressions, deciding whether a change needs a test at all, and choosing the unit or a backend lane.
---

# Testing patterns

This directory is canonical; `.agents/skills/testing-patterns` links here. Using this skill does not authorize suite
cleanup or production changes outside the task.

- Commands, lanes, config and fixtures: [references/repository.md](references/repository.md).
- Vitest facts that matter here, with what was verified: [references/vitest.md](references/vitest.md).
- Smell catalogue with before/after examples and the fault-probe procedure: [references/anti-slop.md](references/anti-slop.md).
- Reviewing or pruning an existing area: [AUDIT.md](AUDIT.md).

## The owner's rules (binding)

> - Every test must earn its place. Tests challenge the code and check that the output is what the code was written
>   for (its purpose/contract), never merely that code runs or exists.
> - No tests that only confirm execution or existence — real developers don't write those.
> - Tests live next to the source files (colocated), never in separate legacy `test/`/`__tests__` folders.
> - Tests must be fast. No excess tests that add nothing.

## Before writing

Read the target, its callers and the nearby tests, then name:

- **Contract:** what the code promises, and to whom.
- **Oracle:** where the expected value comes from (spec, protocol vector, hand-worked example, domain law).
- **Failure:** the plausible bug this test would catch.
- **Existing protection:** what tests, `bun run check` and the lanes already catch.

If you cannot name a contract and an oracle, do not write the test; report the missing intent. "No new test" is a
valid outcome. Prefer extending the owning test over adding a near-duplicate.

## Write

- Call the **real unit through the entry point its users call**: the exported function, the driver, the handler.
- Write expected values as **independent literals**. Never recompute them with the code's logic or a copy of it.
  Oracles here: AWS SigV4 published test vectors, CRC check values (CRC32C of `"123456789"`), the R2 docs, and the
  behaviour measured on real R2 in `docs/research/r2-spike-findings.md`. A differential oracle (our signer against
  `aws4fetch`) is allowed in tests only.
- Use **discriminating inputs**: boundaries (part-size limits, empty and one-byte bodies, the 10,000th part),
  adversarial strings (keys with `/`, `..`, unicode), and the denied or failing case beside the happy path. Two inputs
  from one equivalence class count as one.
- Assert the **exact promised value**: `toBe`/`toEqual`, the `CloudropError` `code` (and `retryable`), the stored
  object, the prohibited request. A bare `toThrow()`, `toBeTruthy()` or `toBeDefined()` is a smell.
- For a bug, write the regression test first and **watch it fail for the right reason**, then fix.
- For a rule over a whole input domain (the part planner), use a fast-check property plus one or two hand-worked
  examples. Keep a shrunk counterexample as a literal case.
- When it is not obvious that an assertion can go red, **prove it**: break the code with a one-line fault probe, watch
  the test fail, restore. Procedure in anti-slop.md.
- Failure messages must say what broke: descriptive test names, `test.each` rows with `$name` titles, and
  `expect(list.filter(isWrong)).toEqual([])` instead of `expect` inside a loop.

## Never write

| # | Smell | Example |
| --- | --- | --- |
| A1 | Tautology: asserting your own setup, a constant equal to its literal, a mock's return value | a rules constant asserted against the literal it was just defined with |
| A2 | Re-implementing the unit in the test, or never importing it | computing the part count with the planner's own formula |
| A3 | Mocking the unit or your own modules; doubles are for network, clock, randomness, SDKs you don't own | `vi.mock("./sigv4")` in `s3-driver.test.ts` |
| A4 | Change-detector tests pinning call order or private structure the contract doesn't promise | asserting `fetch` was called exactly twice when the contract is "the object is stored" |
| A5 | Existence or execution only: "exports", `typeof fn`, `toBeDefined()`, "does not throw" | `expect(r2({ bucket: "b" })).toBeDefined()` |
| A6 | Snapshot spam: `toMatchSnapshot()` writes `__snapshots__/` files nobody reviews | a snapshot of a presigned URL |
| A7 | Testing the framework or a library | `crypto.subtle.digest` on a literal, `URL` parsing, Vitest's own matchers |
| A8 | Coverage chasing: thresholds, tests written to move a number | a test per uncovered line |
| A9 | Duplicated cases: rows hitting the same branch, the same contract again at the same level | part sizes 6 MiB and 7 MiB both "valid middle part" |
| A10 | Logic in tests: `if` around assertions, loops computing expectations, `try/catch` swallowing failures | `if (backend === "r2") expect(...)` in a contract case |
| A11 | Assertion roulette, magic numbers, empty or lazy tests, redundant prints | ten unexplained `expect`s in one test |
| A12 | Green by force: `retry`, `.skip`, an ownerless `test.fails`, loosened assertions, re-recorded baselines | `retry: 3` on a flaky test |

## Doubles

Only for true boundaries. Inject `fetch` and `now` (the driver takes both as options) and use the in-process fake R2
(`src/testing/fake-r2.ts`), which verifies real SigV4 signatures. Never `vi.mock` our own modules. Details: vitest.md.

## Fast and in the right place

- Colocate: `src/foo.ts` → `src/foo.test.ts`. No `test/`, `tests/`, `__tests__/` and no file snapshots.
- The lane is chosen by **filename**. `*.test.ts` is the unit lane (`bun run test`, Vitest). `*.integration.test.ts`
  needs a real backend (RustFS in Docker, Wrangler local R2, live R2) and runs only from its own script.
- The storage contract suite (`src/testing/storage-contract.ts`) runs the same cases against every backend. A backend
  that genuinely lacks a feature declares a capability, and the case calls `ctx.skip(reason)` with a reason naming the
  gap. That is the only allowed skip.
- Budgets: whole unit lane ≤ 5 s cold; one test ≤ 50 ms typical, and anything over 250 ms states its reason in a
  comment. Measure with `--reporter=verbose` (repository.md). Over budget: speed it up, move it to a backend lane, or
  justify it in the test.

## Trustworthy

- Await every promise. A rejection test that can pass without asserting needs `expect.assertions(n)`.
- Restore what you change in `afterEach`: `vi.useRealTimers()`, stubbed globals, `process.env`.
- No `retry`, no skip-to-green. A backend lane whose service or credentials are missing **fails** with a message from
  `beforeAll` saying what to set; it never skips.
- **Register teardown at startup.** Any lane or test that starts a container, process, temp directory or live-R2 object
  registers its cleanup (`afterAll`, `onTestFinished`, or a `trap` in the lane script) at the moment it acquires the
  resource, before the first assertion, so failure, timeout and interruption still clean up. Verify nothing is left
  afterwards (`docker ps -a --filter label=cloudrop.test`, no objects under `live-test/`).

## Decide

- **KEEP:** a useful contract or distinct boundary at acceptable cost.
- **REWRITE:** useful risk, but a weak oracle, inputs, assertion, boundary, speed or reliability.
- **DELETE:** obsolete subject, existence/execution only, or equivalent protection remains. Check callers, fixtures
  and lanes first.
- **UNRESOLVED:** not enough evidence; keep the test and say what would resolve it.

Neither keeping nor reducing counts is a goal.

## Report

The commands actually run and the files they selected, any RED or fault probe actually observed (command and failing
line), boundaries left unproved, and the cleanup you verified.
