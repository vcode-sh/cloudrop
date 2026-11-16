# Dependencies

| Level | Rule |
| --- | --- |
| MUST | `packages/cloudrop` has **zero runtime dependencies**. Adding one needs owner approval; say what it replaces and its size. Dev dependencies are fine. |
| MUST | Before adding anything, check the platform: `fetch`, `crypto.subtle`, `crypto.randomUUID`, `TextEncoder`, `URL`, `AbortSignal.timeout`, `structuredClone`, `Intl`. One tool per job. |
| MUST | Declare every dependency with a caret range (`^1.2.3`), at a version released at least two weeks earlier (ruling M1-N3, owner-confirmed 2026-11-16); `bun.lock` fixes what is installed. A pin, override or bump made because something broke says why in the commit body. |
| MUST | Never hand-edit `bun.lock`. |
| MUST | Remove a dependency in the same change that removes its last import. Check source imports, type-only imports, config files and `package.json` scripts before deleting. |
| SHOULD | Own small, standards-heavy code (SigV4, CRC32C, the XML reader) over importing a general library, when a published test vector or spec makes it verifiable. A differential check against a library (`aws4fetch`) stays in tests only. |
| SHOULD | Optional integrations (React) are optional peer dependencies of their own subpath, never a dependency of the core. |
