# Human-friendly code, messages and output

Levels: **MUST**, **SHOULD**, **AVOID**.

## Names

| Level | Rule |
| --- | --- |
| MUST | One concept, one name everywhere: option, type, error code, docs. A rename is a deliberate, semver-aware change, not drift. |
| MUST | A name is long enough to say fully what the thing is or does. Functions are verbs (`planUpload`), values are nouns, booleans read as questions (`isRetryable`, `hasChecksum`). |
| MUST | A bare number carries its unit in the name: `timeoutMs`, `sizeBytes`, `expiresInSeconds`. |
| AVOID | Names that say nothing: `data`, `info`, `item`, `manager`, `helper`, `utils.ts`, `misc.ts`, `common.ts`. Name the domain noun. The `{ data, error }` result shape is the one deliberate exception. |
| AVOID | Abbreviations other than universal ones (`id`, `url`, `crc`, `etag`). |
| SHOULD | A file is named after its main export, in kebab-case. |

## Module shape

| Level | Rule |
| --- | --- |
| MUST | Deep modules: a small exported surface with the complexity inside. Export what callers use today. |
| MUST | Extend the existing owner before creating a parallel one. |
| MUST | Source files aim at about 200 to 220 lines; `bun run check` fails one over 250 (400 for a `*.test.ts` file). Get under by splitting responsibilities, never by reformatting or deleting comments that explain why. |
| SHOULD | Split a function when two concerns change independently, not because it is long. |
| SHOULD | Early returns for preconditions, so the happy path reads top to bottom without nesting. |
| AVOID | Layers that only forward calls. |
| AVOID | Classes for stateless logic; module functions are simpler. |
| AVOID | New barrel files (`export *` index modules) beyond each subpath's entry file. Import from the module that defines the thing. |

## Comments and docs

| Level | Rule |
| --- | --- |
| MUST | Comments explain **why**: a constraint, invariant, trade-off or measured behaviour (for R2, point at `docs/research/r2-spike-findings.md`). The code already says what. |
| MUST | A stale comment is a defect: change it in the same commit as the code. |
| SHOULD | TSDoc on every exported symbol whose contract the signature does not show (units, defaults, what is retried, what the caller must close). It is the library's documentation in editors. |
| AVOID | TSDoc that restates the signature (`@param id - the id`), task or PR references, essays. |
| AVOID | `TODO` without a reason; do it now or record it where work is tracked. |

## Messages

Applies to every message a person reads: `CloudropError.message`, thrown configuration errors, script output.

| Level | Rule |
| --- | --- |
| MUST | One or two plain sentences: what went wrong **and what to do next**. No jargon, no implementation detail. Good: `"The R2 accountId is missing. Pass it to r2() or set CLOUDROP_R2_ACCOUNT_ID."` (the plan's config error) Bad: `"InvalidPart"`, `"Something went wrong"`. |
| MUST | Programs branch on the stable `code`, `retryable` and typed fields, never on message text, so a message can be reworded freely. |
| MUST | No credentials, signed URLs, raw storage response bodies or server file paths in a message. The storage service's own code goes into `storageCode` for logs only. |
| SHOULD | A configuration error names the option and the fix (`"bucket is empty. Pass the bucket name: r2({ bucket })."`) and is thrown at construction as `INVALID_CONFIG`, not on the first request. |

## Script and lane output

Applies to `scripts/*` and package scripts ([clig.dev](https://clig.dev/)).

| Level | Rule |
| --- | --- |
| MUST | Primary output to stdout, diagnostics and errors to stderr. Exit 0 on success, non-zero on failure. |
| MUST | Expected failures are rewritten for humans: what failed, why, and the next command or variable to set. No stack trace for an expected failure. |
| MUST | Never print credentials or presigned URLs, including in debug output. |
| MUST | When a script changes state (starts or removes a container, deletes live objects), say what changed in one line. |
| SHOULD | Put the most important line last; keep success output brief. |
| SHOULD | Colour only on a TTY and never when `NO_COLOR` is set. |
