# Anti-slop catalogue

Every entry follows from the owner's rules in [SKILL.md](../SKILL.md). The before/after pairs are illustrative: they
show the shape of the smell. Function names and signatures in them are placeholders; use the real ones.

## The question to ask of every assertion

*Which plausible bug turns this red?* If the answer is "none" or "only a typo in the test", the assertion is slop.
If you are not sure, run a fault probe (below).

## Before / after

**A1 Tautology: a constant echoed back.** It can only fail if someone edits the constant, and then it fails for the
wrong reason. Test the relation the code promises instead (every planned part except the last is the same size and at
least the minimum), not the number.

```ts
// before
expect(MIN_PART_SIZE).toBe(5 * 1024 * 1024);
// after: the behaviour on an input is the oracle
expect(planParts({ size: 11 * MiB, partSize: 5 * MiB }).map((p) => p.size)).toEqual([5 * MiB, 5 * MiB, 1 * MiB]);
```

**A3 Mocking your own module.** The test proves the mock, not the signer.

```ts
// before
vi.mock("./sigv4", () => ({ signRequest: () => ({ authorization: "x" }) }));
// after: the real signer, an injected clock, an AWS published vector as the oracle
const signed = await signRequest(vectorRequest, { credentials, now: () => VECTOR_TIME });
expect(signed.headers.authorization).toBe(VECTOR_AUTHORIZATION);
```

**A5 Execution only.** "Does not throw" and "is defined" pass for a driver that does nothing.

```ts
// before
expect(await driver.put("a/b", bytes)).toBeDefined();
// after: observe the effect through the same contract
await driver.put("a/b", bytes);
expect(await driver.head("a/b")).toMatchObject({ size: bytes.byteLength });
```

**Bare `toThrow()`: any error passes, including a `TypeError` from a bug.**

```ts
// before
expect(() => r2({ bucket: "" })).toThrow();
// after
expect(() => r2({ bucket: "" })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
```

**A10 Logic in a test.** `expect(parts.filter(isWrongSize)).toEqual([])` names the failing part; a loop with `expect`
inside does not. A branch on the backend belongs in a declared capability and `ctx.skip(reason)`, not an `if`.

**Missing discriminating case.** A guard rejecting `size === 0` passes "empty" and "normal" tests even if it regresses
to `size < 2`. A one-byte row tells them apart.

## Fault probe

Use it when it is not obvious that a test can go red.

1. Work on files you own exclusively; for anything shared, use an isolated worktree at
   `~/projects/.worktrees/cloudrop/<slug>` (never `/tmp`, never nested in the repo).
2. Back up the file, make **one** plausible one-line mutation in the production code (flip a guard, drop a field,
   widen a check, change an off-by-one in a part boundary).
3. Run the focused test (`bun run --cwd packages/cloudrop test src/foo.test.ts`). Record which test fails and why.
4. Restore the file from the backup and confirm `git diff` shows no change to it.

A surviving mutant is a finding: the assertion is weak, the mutation is equivalent, or the branch is unreachable.
Decide which before adding a test. A kill does not validate the oracle. No mutation-score gate; probes are manual.

## Sources

Michael Bromley, "The Problem With Your AI Tests" (2026); Ouédraogo et al., "On the Diffusion of Test Smells in
LLM-Generated Unit Tests" (arXiv 2410.10628); Siddiq et al. (arXiv 2305.00418); *Software Engineering at Google*
ch. 12 "Unit Testing"; Google Testing Blog, "Change-Detector Tests Considered Harmful" (2015); Kent C. Dodds,
"Effective Snapshot Testing"; Petrović et al., "Does mutation testing improve testing practices?" (ICSE'21);
Inozemtseva & Holmes, "Coverage is not strongly correlated with test suite effectiveness" (ICSE'14).
