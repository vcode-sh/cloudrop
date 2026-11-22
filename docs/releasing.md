# Releasing cloudrop

This page is for the maintainer who publishes a release. `cloudrop` is published to npm by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) when a tag `v<version>` is pushed. It authenticates
with npm **trusted publishing**: npm trusts that workflow file, in this repository, running in the GitHub environment
`npm`, and the npm CLI swaps the job's short-lived OIDC credential for a one-time publish credential. No npm token
exists, in GitHub secrets or anywhere else.

The workflow has two jobs:

1. **build** (read-only, no OIDC): checks that the tag matches the version in `packages/cloudrop/package.json` and
   points at a commit on `main`, runs `bun run verify`, packs the package and keeps the tarball as an artifact for 7
   days.
2. **publish** (environment `npm`, OIDC only): waits for a reviewer's approval, then publishes that exact tarball with
   `npm publish --access public`. It checks out no code and installs no dependencies, so nothing from the repository
   or its dependencies runs while the publish permission exists. A prerelease version (`1.0.0-beta.1`, `0.2.0-rc.1`)
   is published under the dist-tag `next`; every other version under `latest`.

**The approval:** the `npm` environment has one required reviewer, `vcode-sh`, and accepts only tags matching `v*`. A
run's **publish** job waits until that reviewer approves it ([Release a version](#release-a-version), step 4); nothing
is published before. **Prevent self-review** is off, so the maintainer who pushed the tag approves it, and GitHub's
default **Allow administrators to bypass configured protection rules** is on, so a repository administrator can also
start the job without the review. Because the repository is public, npm adds a provenance statement to each version on
its own (a signed link from the version to this repository, commit and workflow run); the workflow never passes
`--provenance`. Checked 2026-11-22 (`gh api repos/vcode-sh/cloudrop/environments/npm`, the run's approvals and
`npm view cloudrop@0.6.0 dist.attestations`): this workflow published 0.1.1 to 0.6.0, 0.6.0's **publish** was approved
by `vcode-sh` in `npm`, and 0.6.0 carries provenance.

## First release, in order

The one-time setup below is done for `vcode-sh/cloudrop`. This order is for doing it again, for a renamed repository
or a new owner. The trusted publisher (step 5) must publish successfully within **2 days** of being created, or it
expires and must be deleted and created again.

1. **Make the repository public:** in the repository, **Settings → General → Danger Zone → Change visibility**.
2. **Create the environment `npm` with required reviewers:** [The GitHub environment](#the-github-environment-npm).
3. **Turn on two-factor authentication** for the npm account: [npm account](#npm-account).
4. **Prepare the release commit** and push it to `main` without a tag: steps 1 and 2 of
   [Release a version](#release-a-version). Wait until CI is green.
5. **Add the trusted publisher** on npmjs.com: [The trusted publisher](#the-trusted-publisher).
6. **Tag and approve:** steps 3 and 4 of [Release a version](#release-a-version). The version is on npm when
   **publish** ends.
7. **Disallow tokens** for the package: [Disallow tokens](#disallow-tokens).
8. **Revoke every npm token:** [Revoke tokens](#revoke-tokens).

## Release a version

1. On `main`, with CI green, set `version` in `packages/cloudrop/package.json` (for example `1.0.0`) and turn the
   `## Unreleased` heading of `packages/cloudrop/CHANGELOG.md` into `## 1.0.0 - YYYY-MM-DD`, with a new empty
   `## Unreleased` above it. Commit them in one commit and push it:

   ```bash
   git add packages/cloudrop/package.json packages/cloudrop/CHANGELOG.md
   git commit -m "chore(release): 1.0.0"
   git push origin main
   ```

2. Optionally, see what will be published: `bun run build && cd packages/cloudrop && npm pack --dry-run`.
3. Tag that commit and push the tag:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

4. Open the run under **Actions → release**. When **build** passes, **publish** waits for the `npm` environment and
   GitHub notifies its required reviewer: choose **Review deployments**, tick `npm` and choose **Approve and deploy**.
   **Reject** instead ends **publish** without publishing anything.

## If a release fails

**build fails** on the tag check: the tag and the version disagree, or the tag points at a commit that is not on
`main`. Delete the tag (`git push origin :v1.0.0` and `git tag -d v1.0.0`), fix the version or tag the right commit on
`main`, and push the tag again. A failed `bun run verify` is fixed the same way, with a new commit on `main`.

**publish fails:** first check whether the version reached npm: `npm view cloudrop versions`.

- **The version is not on npm.** Fix the cause, then open the run and choose **Re-run failed jobs**: **publish** runs
  again with the same tarball, without rebuilding. The artifact is kept for 7 days; after that, delete the tag and
  push it again. The usual causes on a first release, all reported as an authentication error or a 404:
  - the trusted publisher does not allow **npm publish** (a new configuration allows only `npm stage publish`);
  - the trusted publisher expired (no successful publish within 2 days) or has a typo: delete it and add it again;
  - the environment name differs between the trusted publisher and the `publish` job;
  - `repository.url` in `package.json` does not match the repository (see [Package metadata](#package-metadata)).
- **The version is on npm.** Do not re-run: npm refuses a version it already has (`You cannot publish over the
  previously published versions`), even after an unpublish. Fix forward with the next patch version.
- **The download of the artifact fails for lack of a scope.** The `publish` job grants only `id-token: write`. A
  re-run replays the workflow file of the tagged commit, so editing it on `main` changes nothing for this tag: add
  `contents: read` back to the job's `permissions` in a new commit on `main`, then delete the tag and tag the new
  commit, as for a failed tag check.

## One-time setup

### The GitHub environment `npm`

In the repository `vcode-sh/cloudrop`: **Settings → Environments → New environment**.

- **Name:** `npm` (exact and case-sensitive: npm compares it with the trusted publisher's environment name).
- **Required reviewers:** add yourself, and tick **Prevent self-review** only if someone else will approve.
- **Deployment branches and tags:** choose **Selected branches and tags**, then **Add deployment branch or tag rule**,
  type **Tag** and pattern `v*`. Nothing but a release tag can then run in this environment.
- Add no secrets and no variables to it.

### Branch protection on `main`

**Settings → Rules → Rulesets → New branch ruleset** for `main`. The repository has one, named `main` and active,
with the rules below (checked 2026-11-22 with `gh api repos/vcode-sh/cloudrop/rulesets`).

- **Require status checks to pass:** `check`, `rustfs`, `wrangler`, `chaos`, `db`, `drizzle-0-45` and `browser`, the
  CI job names. `chaos-soak` and `live-r2` run only on a schedule or by hand; never require them, or no pull request
  can merge.
- **Block force pushes** and **restrict deletions**.
- **Let administrators bypass** the rule: the maintainer pushes to `main` directly, and CI runs on that push. A
  release waits for it to be green ([Release a version](#release-a-version), step 1).

### npm account

On npmjs.com, **Account → Two-Factor Authentication** must be on (an authenticator app or a security key). It is
required to disallow tokens.

### The trusted publisher

On [npmjs.com/package/cloudrop](https://www.npmjs.com/package/cloudrop) (signed in as `vcode.sh`): **Settings →
Trusted publishing**, choose **GitHub Actions** and fill in, exactly:

| Field | Value |
| --- | --- |
| Organization or user | `vcode-sh` |
| Repository | `cloudrop` |
| Workflow filename | `release.yml` (the file name only, not the path) |
| Environment name | `npm` |
| Allowed actions | tick **npm publish** (a new configuration allows only `npm stage publish` until you do) |

Leave **npm dist-tag** unticked: the workflow sets the dist-tag while publishing and never runs `npm dist-tag`. A
configuration cannot be edited once saved; to change a field, delete it and add it again.

### Disallow tokens

After the first release succeeds through the workflow: on the package page, **Settings → Publishing access**, choose
**Require two-factor authentication and disallow tokens** and save with **Update Package Settings**. From then on no
npm token can publish `cloudrop`, whatever its scope; trusted publishing still can.

### Revoke tokens

On npmjs.com, **Account → Access Tokens**: revoke every token, the leaked one first. Nothing in this repository uses a
token, and disallowing tokens already stops them from publishing `cloudrop`; revoking them also stops them from
publishing or changing any other package of the account. If a machine still needs to read private packages, create a
new read-only granular token for it instead of keeping an old one.

## Package metadata

Trusted publishing compares `repository.url` in the published `package.json` with the repository the workflow runs in,
so `packages/cloudrop/package.json` keeps `repository.url` at `git+https://github.com/vcode-sh/cloudrop.git` and
`repository.directory` at `packages/cloudrop`; `bun run package:check` (`scripts/check-package.sh`) fails when either
changes. If the repository is renamed or moves to another owner, change both fields, that script and the
[trusted publisher](#the-trusted-publisher) together. `publishConfig.access` is `public` and `files` ships `dist` and
`CHANGELOG.md`; npm adds `README.md`, `LICENSE` and `package.json` itself.

## References

- npm: [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers),
  [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements).
- GitHub: [OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect),
  [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
  [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
