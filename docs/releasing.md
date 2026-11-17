# Releasing cloudrop

`cloudrop` is published to npm by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a tag
`v<version>` is pushed. It authenticates with npm **trusted publishing**: npm trusts that workflow file, in this
repository, running in the GitHub environment `npm`, and the npm CLI swaps the job's short-lived OIDC credential for a
one-time publish credential. No npm token exists, in GitHub secrets or anywhere else.

The workflow has two jobs:

1. **build** (read-only, no OIDC): checks that the tag matches `packages/cloudrop/package.json`, runs
   `bun run verify`, packs the package and keeps the tarball as an artifact.
2. **publish** (environment `npm`, OIDC): waits for a reviewer's approval (public repository only, see below), then
   publishes that exact tarball with `npm publish --access public`. It checks out no code and installs no
   dependencies, so nothing from the repository or its dependencies runs while the publish permission exists. A
   prerelease version (`1.0.0-beta.1`, `0.2.0-rc.1`) is published under the dist-tag `next`; every other version under
   `latest`.

## Release a version

1. On `main`, with CI green, set `version` in `packages/cloudrop/package.json` (for example `0.1.0`) and turn the
   `## Unreleased` heading of `packages/cloudrop/CHANGELOG.md` into `## [0.1.0] - YYYY-MM-DD`, with a new empty
   `## Unreleased` above it. Commit both in one commit:

   ```bash
   git add packages/cloudrop/package.json packages/cloudrop/CHANGELOG.md
   git commit -m "chore(release): 0.1.0"
   ```

2. Optionally, see what will be published: `bun run build && cd packages/cloudrop && npm pack --dry-run`.
3. Tag that commit and push the commit and the tag:

   ```bash
   git tag v0.1.0
   git push origin main v0.1.0
   ```

4. Open the run under **Actions → release**. When **build** passes, **publish** waits for the `npm` environment:
   choose **Review deployments**, tick `npm` and approve (while the repository is private there is no approval step
   and **publish** starts on its own). The version is on npm when the job ends.

If **build** fails on the tag check, the tag and the version disagree: delete the tag (`git push origin :v0.1.0` and
`git tag -d v0.1.0`), fix the version or tag the right commit, and push the tag again. A version npm already has can
never be published again, not even after it is unpublished: fix forward with the next patch version.

## One-time setup

Do these once, in this order. The trusted publisher must publish successfully within **2 days** of being created, or it
expires and must be deleted and created again, so do step 3 right before the first release.

### 1. Create the GitHub environment `npm`

In the repository `vcode-sh/cloudrop`: **Settings → Environments → New environment**.

- **Name:** `npm` (exact and case-sensitive: npm compares it with the trusted publisher's environment name).
- **Required reviewers:** add yourself, and tick **Prevent self-review** only if someone else will approve.
- **Deployment branches and tags:** choose **Selected branches and tags**, then **Add deployment branch or tag rule**,
  type **Tag** and pattern `v*`. Nothing but a release tag can then run in this environment.
- Add no secrets and no variables to it.

While the repository is private, GitHub limits these rules by plan: required reviewers need a public repository (or
GitHub Enterprise), and the tag rule needs GitHub Pro or Team. See
[While the repository is private](#while-the-repository-is-private).

### 2. Make sure the npm account uses two-factor authentication

On npmjs.com, **Account → Two-Factor Authentication** must be on (an authenticator app or a security key). It is
required for the package setting in step 4.

### 3. Add the trusted publisher on npmjs.com

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

### 4. Disallow tokens for the package

After the first release succeeds through the workflow: on the package page, **Settings → Publishing access**, choose
**Require two-factor authentication and disallow tokens** and save with **Update Package Settings**. From then on no
npm token can publish `cloudrop`, whatever its scope; trusted publishing still can.

### 5. Revoke every npm token

On npmjs.com, **Account → Access Tokens**: revoke every token, the leaked one first. Nothing in this repository uses a
token, and step 4 already stops tokens from publishing `cloudrop`; revoking them also stops them from publishing or
changing any other package of the account. If a machine still needs to read private packages, create a new read-only
granular token for it instead of keeping an old one.

## Package metadata

Trusted publishing compares `repository.url` in the published `package.json` with the repository the workflow runs in,
so `packages/cloudrop/package.json` keeps `repository.url` at `git+https://github.com/vcode-sh/cloudrop.git` and
`repository.directory` at `packages/cloudrop`; `bun run package:check` fails when either changes. If the repository is
renamed or moves to another owner, change both fields and the trusted publisher together. `publishConfig.access` is
`public` and `files` ships `dist` and `CHANGELOG.md`; npm adds `README.md`, `LICENSE` and `package.json` itself.

## While the repository is private

Trusted publishing works from a private repository, but three things change until the repository is public:

- **No approval step.** On GitHub Free, Pro and Team, an environment's required reviewers work only in public
  repositories, so the **publish** job starts as soon as **build** passes: pushing a `v*` tag is the release. Only
  people with write access can push a tag, and on Pro or Team the environment's tag rule still keeps everything but a
  `v*` tag out of `npm`. For a human check that does not depend on GitHub's plan, npm's
  [staged publishing](https://docs.npmjs.com/staged-publishing) holds a version until a maintainer approves it on
  npmjs.com with two-factor authentication: change the publish step's `npm publish` to `npm stage publish` and allow
  only **npm stage publish** in the trusted publisher. The workflow does not do this today.

- **No provenance.** npm adds a provenance statement (a signed link from the published version to this repository,
  commit and workflow run) on its own only when the repository is public. From a private repository the version is
  published without one, so npm shows no provenance badge. That is why the workflow does not pass `--provenance` and
  `package.json` has no `publishConfig.provenance`: forcing provenance from a private repository makes npm refuse the
  whole publish. Once the repository is public, the next release gets provenance with no change to the workflow.
- **Links that 404.** The package README links its guides at `https://github.com/vcode-sh/cloudrop/blob/main/...`,
  and `repository`, `homepage` and `bugs` in `package.json` point at the repository. For anyone without access, every
  one of those links is a GitHub 404, on npmjs.com and in editors that show the README.

What to do: make the repository public before the first release, or at the latest right after it, so the page and
the links work and every later version carries provenance. If it has to stay private for longer, publish with the
README as it is (the quickstart and the bucket rules in it are complete on their own) and expect the broken links
until then.

## References

- npm: [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers),
  [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements),
  [Staged publishing](https://docs.npmjs.com/staged-publishing).
- GitHub: [OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect),
  [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
