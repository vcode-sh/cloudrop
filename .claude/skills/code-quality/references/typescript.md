# TypeScript

## Compiler decisions

The package builds with `strict`, `noUncheckedIndexedAccess` and `isolatedDeclarations` (M1 plan "Global constraints").
Read `packages/cloudrop/tsconfig.json` for the rest rather than trusting this page.

- `isolatedDeclarations` means every exported function and constant has an explicit type. That is also what keeps the
  public API readable in editors and stable under semver.
- Do not set options the current TypeScript always applies; check the tool's default before adding a line to the config.

## Idioms

| Level | Rule |
| --- | --- |
| MUST | One source of truth for a shape: derive types from the value (`typeof`, `as const`) or from the interface, not a second hand-written copy. |
| MUST | `as` only directly after a runtime check that proves it, or at a platform seam with a comment saying why. `unknown` at boundaries, narrowed before use. |
| MUST | Results that can fail in expected ways are discriminated unions (`{ data, error: null } \| { data: null, error }`), handled with an exhaustive `switch` ending in a `never` check. Public calls return `Result<T>` and do not throw for expected failures. |
| SHOULD | `satisfies` for config objects and lookup maps, so literal types survive and typos fail: `const statusLabel = { … } satisfies Record<Status, string>`. `as const` objects instead of enums. |
| SHOULD | `interface … extends` over large intersections: cached and flatter for the checker. |
| SHOULD | `await using` for resources acquired and released in one scope (test fixtures, scripts), when the resource implements `Symbol.asyncDispose` and every supported runtime has it [works on Node 24.22, measured 2026-11-16, and on Node 26.13, the floor, measured 2026-11-22; unverified for Workers]. |
| AVOID | Exporting a type only to name an internal intermediate; every exported type is public API. |
