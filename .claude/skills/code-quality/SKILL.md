---
name: code-quality
description: Write, review and simplify cloudrop's code. The simplify-on-review rule, the AI-slop deletion checklist, human-friendly names, comments, messages and script output, library rules (public surface, zero dependencies, web-platform APIs), performance and dependency checks. Use after writing code, before committing, and when reviewing any diff.
---

# Code quality

This directory is canonical; `.agents/skills/code-quality` links here. cloudrop is a published library: every export
is a promise under semver, and every byte and dependency lands in someone else's bundle.

## The owner's rules (binding)

> 1. Everything created here must be human friendly — code, APIs (endpoint/procedure names, inputs, outputs, errors), docs, CLI
>    output, error messages.
> 2. Agents reviewing code must simplify when the same result is achievable with less code: if 200 lines can be done
>    in fewer while keeping full functionality, performance and the newest standards, agents always optimize
>    (simplify) their code.
> 3. Code quality and performance per 2026 best practice.

In cloudrop, "APIs" means function names, options, results and `CloudropError`.

## What the tools already own

`bun run check` and `bun run typecheck` enforce formatting, lint, types, file size (250 lines for a source file, 400
for a `*.test.ts` file, through `scripts/check-file-size.ts`) and cognitive complexity (at most 15 per function,
Biome's `noExcessiveCognitiveComplexity`). Spend no review words on what they report.

Review owns what no tool checks: parameter count, barrel files, `as` casts, names, comments, message wording, API
shape, public surface, waterfalls, allocations on hot paths and bundle cost.

## Library rules

- **Every export is a public promise.** Export only what a caller needs. No barrel re-exports beyond the subpath entry
  files. A new export, or a changed signature, is a semver decision: say so.
- **Zero runtime dependencies.** A new dependency in `packages/cloudrop` needs owner approval
  ([references/dependencies.md](references/dependencies.md)).
- **Web-platform APIs only** in library source (`fetch`, `crypto.subtle`, `TextEncoder`, `URL`): no `node:` imports,
  no `process`, no `Buffer`, so it runs in Node 24+, Bun, Deno, Workers and browsers. The compiler enforces it; the
  guarded `fromEnv` in `src/env.ts` is the library's only access to the environment.
- **Errors tell a person what to do.** `message` says what happened and what to do next; programs branch on `code`
  and `retryable`. A message never carries credentials, signed URLs or raw storage bodies.
- **Performance is measured.** Hot paths avoid per-byte and per-call allocations and repeated key derivation; a speed
  claim carries a number or is marked unverified ([performance.md](references/performance.md)).

## The simplify rule

A rewrite is **required** when it keeps behaviour, performance, types and standards (the four gates) and scores lower:
first fewer **concepts** a reader must hold (exported symbols, parameters, declared types, files, indirection hops,
branches), then fewer **code lines**. Fewer concepts wins even with a few more lines. Clarity is part of the
behaviour: a shorter version that hides intent is **golf** and fails review.

The file-size cap outranks the score: a file over its cap is split by responsibility even though the split adds
files.

Simplification removes **accidental complexity**, never the project's conventions: the `Result<T>` shape, the injected
`fetch` and `now` options, the storage contract suite, files the owner installed.

Deleting a **whole file or dependency** needs proof that it is dead **and** not a convention
([simplify-rule.md](references/simplify-rule.md)); otherwise list it for owner confirmation.

Scope: your own diff, always; anything else is a listed follow-up. Gates, score, golf list and examples:
[references/simplify-rule.md](references/simplify-rule.md).

## Review procedure

Run it on your own code before committing and on every diff you review. Each step is done when its condition holds.

1. **Read** the diff, its immediate callers and the nearby tests. Done when you can name what each changed function
   promises its callers.
2. **Correctness first**: bugs, input bounds, error codes, secrets in messages (`/code-review` helps). A simpler
   wrong program is not a win. Done when every finding is fixed or reported.
3. **Delete** with the slop checklist S1–S11 ([references/slop-checklist.md](references/slop-checklist.md)). Done
   when every row has been checked against every changed file.
4. **Simplify** what remains with the rule above. Done when no gated rewrite with a lower score is left in scope.
5. **Human-friendly pass** ([references/human-friendly.md](references/human-friendly.md)): names, comments, messages,
   script output. Done when every new name, comment and message passes its table.
6. **Performance pass** ([references/performance.md](references/performance.md)): hot-path allocations, waterfalls,
   timeouts, bundle weight. A speed claim carries a number or is marked unverified.
7. **Gates**: `bun run check`, `bun run typecheck`, `bun run test`, plus the backend lane scripts when the change
   touches the driver, signer or contract suite. Existing tests pass **unchanged** unless they asserted
   implementation detail; say which and why.
8. **Report** findings by severity. For each simplification: file, `before → after` code lines and concepts, what
   went and why, and the behaviour evidence. For each rejected candidate: the gate or golf rule it failed. Whole files
   and dependencies you did not delete go under "for owner confirmation".

TypeScript idioms: [references/typescript.md](references/typescript.md). Tests: the `testing-patterns` skill.

## Rationalizations

| Excuse | Reality |
| --- | --- |
| "It works and tests pass." | Slop works and passes tests; it costs the next reader. Run S1–S11. |
| "The extra check is defensive." | A check for a state the types exclude is noise that hides the real checks. |
| "We might need this option later." | Then add it later. An exported option cannot be taken back. |
| "Fewer lines is always simpler." | Fewer concepts is simpler. Golf fails review. |
| "The helper avoids duplication." | Two callers do not justify an abstraction; the wrong one costs more than the copy. |
| "The message is for developers." | People read `message`. Developers get `code`, `retryable` and logs. |
