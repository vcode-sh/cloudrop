# The simplify rule

A rewrite **R** of code **C** is **required** when every gate passes and R wins the score.

## What it targets

Accidental complexity only: needless layers, indirection that makes no decision, options nobody passes, duplicated
logic, and defensive noise (checks for states the types exclude). The project's conventions and infrastructure are not
complexity, even when they are short or have no importer yet (see "Golf" below).

## Deleting a whole file or dependency

Delete it in a simplify pass only when both hold:

1. **Provably dead**: no runtime import, type import, config reference (`package.json` `exports`, tsconfig, bundler
   config), script or documented pointer reaches it.
2. **Not a convention**: not the project's chosen tool for its job, not an entry point that upcoming work needs, not an
   owner-installed file.

Otherwise list it in the report under "for owner confirmation", with the evidence and the saving, and leave it.

## Gates (all must hold)

| Gate | R must… | How to check |
| --- | --- | --- |
| Behaviour | Produce the same observable behaviour for every input the contract admits: return values, `CloudropError` codes and messages, requests sent to storage, ordering callers depend on. | Existing tests pass **unchanged**. If no test covers the changed behaviour, add or name one first, or state the manual check. |
| Performance | Add no network round trip, sequential `await`, per-call allocation on a hot path or bundle weight; keep or improve asymptotic complexity. | Diff review; a measurement for anything on a hot path. |
| Types | Keep or tighten types: no new `any`, `as`, `!`, `@ts-expect-error`, widened union or lost explicit export type; exhaustiveness kept. | `bun run typecheck`; grep the diff for `as ` and `!`. |
| Standards | Pass `bun run check` and the library rules in SKILL.md; use current, non-deprecated APIs. | Gate output. |

## Score (lower wins; compare in order, stop at the first difference)

1. **Concepts** a reader must hold: exported symbols + parameters and options + declared types + files + indirection
   hops from the caller to the code that does the work + branches.
2. **Code lines**: non-blank, non-comment lines of the touched files (count by hand or with `tokei`).

Fewer concepts wins even with slightly more lines; with equal concepts, fewer lines wins.

## Scope

- Your own diff: always apply.
- Files your diff touches, same concern, covered by tests: apply.
- Anything else: list it as a follow-up with the estimated saving. No drive-by refactors.

## Golf: shorter but not simpler

Leave these as they are, even when they cut lines:

- Nested ternaries, `&&`/`||` chains for side effects, `reduce` where `for…of` reads plainer, comma tricks, one-letter
  names.
- Inlining a named intermediate that explains a condition (`const isExpired = …`). A named boolean is one concept the
  reader no longer has to derive.
- Removing validation at a **trust boundary**: caller input to a public function, the key and metadata checks, upload
  token verification, parsing of storage responses.
- Removing error handling at an **I/O boundary** (the mapping of a storage failure to a `CloudropError`), or a comment
  that explains *why*.
- Deleting or weakening tests to shrink a diff.
- Merging two concerns into one function because they sit next to each other.
- Extracting a shared helper for two similar blocks. Wait for the third real caller, or a real adapter boundary.
- Renaming or reformatting code outside the task's scope.
- Removing the injected `fetch` and `now` options: they are how tests and non-standard runtimes reach the code, not
  unused parameters.
- Removing an entry point that upcoming work needs, or a file the owner installed, unless the owner confirms.

## Worked examples

**Wrapper with no decision (S5): inline.**

```ts
// Before: 2 concepts (getBucketName, its parameter) and a hop
function getBucketName(config: StorageConfig) {
  return config.bucket;
}
const bucket = getBucketName(config);

// After: 0 extra concepts
const bucket = config.bucket;
```

**Explaining name: keep.** `if (ageMs > ttlMs)` beats `if (now() - issuedAt > ttlMs)` only when the name says
something the expression does not; `const isExpired = ageMs > ttlMs` is worth its line when the condition is reused or
the threshold has a reason.

**Config that restates a default: delete.** A compiler or bundler option set to the value it already has costs a reader
a decision that does not exist. Check that the tool's default really is that value (run it with the line removed)
before deleting.
