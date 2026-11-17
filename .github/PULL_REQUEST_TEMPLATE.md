## What and why

<!-- What this changes and why. One concern per pull request. -->

## Kind of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change (an export, option, result or error code changes)
- [ ] Documentation
- [ ] Refactor or tests only

## Checklist

- [ ] `bun run verify` passes
- [ ] The lanes this change touches pass (see [CONTRIBUTING.md](https://github.com/vcode-sh/cloudrop/blob/main/CONTRIBUTING.md#the-test-lanes)): `test:rustfs`, `test:wrangler`, `test:db`, `test:chaos`, `test:browser`
- [ ] If it changes how cloudrop talks to R2, the description says so (the maintainer runs the live R2 lanes)
- [ ] New tests check a contract a caller relies on; no test was loosened, skipped or retried to pass
- [ ] Behaviour or a public contract changed, and `docs/decisions/` has an entry for it
- [ ] Docs and examples match the new behaviour
- [ ] `packages/cloudrop/CHANGELOG.md` has an entry under `## Unreleased` (if a user would notice)
- [ ] No new runtime dependency in `packages/cloudrop`, and no credentials or presigned URLs in messages or logs

## How it was checked

<!-- The behaviour you checked, the commands you ran, and anything you could not check. -->

## Related issues

<!-- Fixes #123 -->
