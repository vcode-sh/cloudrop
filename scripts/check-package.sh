#!/usr/bin/env bash
# Checks what npm would publish (`bun run package:check`, after `bun run build`): the packed tarball must hold the
# README, LICENSE and CHANGELOG, the repository that trusted publishing checks and the Node 26 floor in engines.node
# (M12-P2), index.js must load none of the store's code (M12-S1), the built bin must run, publint and attw read the
# tarball, and size-limit reads the built entries. The
# tarball goes to a scratch directory that the trap removes on success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/cloudrop"
if [ ! -f dist/index.js ]; then
  echo "No build in packages/cloudrop/dist. Run bun run build first." >&2
  exit 1
fi
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun pm pack --destination "$SCRATCH" --quiet >/dev/null
TARBALL=("$SCRATCH"/*.tgz)
# npm shows the README on the package page and the license must travel with the code (M4-F19). The pack adds both on
# its own when they sit next to package.json, and the changelog through `files`, so this catches a deleted or renamed
# file.
CONTENTS="$(tar -tzf "${TARBALL[0]}")"
for required in README.md LICENSE CHANGELOG.md docs/README.md docs/server.md; do
  if ! grep -qx "package/$required" <<<"$CONTENTS"; then
    echo "The packed tarball has no $required. Add packages/cloudrop/$required." >&2
    exit 1
  fi
done
if ! cmp -s "$ROOT/LICENSE" LICENSE; then
  echo "packages/cloudrop/LICENSE differs from the repository's. Copy it: cp LICENSE packages/cloudrop/LICENSE" >&2
  exit 1
fi
# npm's trusted publishing refuses a package whose repository.url is not the repository the workflow runs in, and the
# directory points npm's page and provenance at the package inside it. A rename of the repository changes this value,
# package.json and the trusted publisher together (docs/releasing.md, "Package metadata" and "The trusted publisher").
EXPECTED_REPOSITORY="git+https://github.com/vcode-sh/cloudrop.git packages/cloudrop"
READ_REPOSITORY='const { repository: r } = JSON.parse(require("fs").readFileSync(0, "utf8"));
r ? r.url + " " + r.directory : "none"'
REPOSITORY="$(tar -xzOf "${TARBALL[0]}" package/package.json | node -p "$READ_REPOSITORY")"
if [ "$REPOSITORY" != "$EXPECTED_REPOSITORY" ]; then
  echo "packages/cloudrop/package.json has repository \"$REPOSITORY\"." \
    "Set repository.url to git+https://github.com/vcode-sh/cloudrop.git" \
    "and repository.directory to packages/cloudrop." >&2
  exit 1
fi
# Node 26 is the floor (M12-P2): npm warns an app on an older Node at install from this field.
READ_ENGINES='JSON.parse(require("fs").readFileSync(0, "utf8")).engines?.node ?? "none"'
ENGINES="$(tar -xzOf "${TARBALL[0]}" package/package.json | node -p "$READ_ENGINES")"
if [ "$ENGINES" != ">=26" ]; then
  echo "packages/cloudrop/package.json has engines.node \"$ENGINES\". Set it to \">=26\" (M12-P2)." >&2
  exit 1
fi
# cloudrop/testing and cloudrop/plugins must use the server's own CloudropError (M9-T2, M10-K5): a copy of the class
# fails the server's instanceof check, and every refusal from a plugin would reach the client as a server error.
for entry in testing plugins; do
  if grep -q "class CloudropError" "dist/$entry.js"; then
    echo "dist/$entry.js carries its own CloudropError. Build it apart, importing src/index.ts (tsdown.config.ts)." >&2
    exit 1
  fi
  if ! grep -q 'from "./index.js"' "dist/$entry.js"; then
    echo "dist/$entry.js does not import ./index.js. Build it apart, importing src/index.ts (tsdown.config.ts)." >&2
    exit 1
  fi
done
# A server without a store must not load the store's code (M12-S1). One message per module of StorePaths stands for
# it: each must be in the files dist/store.js loads, so a reworded message cannot pass unseen, and none in the files
# dist/index.js loads, each entry followed through its static imports as the size budgets follow them.
STORE_MARKERS=(
  "could not check your storage limit"        # src/server/store-upload.ts
  "returned more than 16 KiB of JSON"         # src/server/store-complete.ts
  "could not reach its upload records"        # src/server/store-calls.ts
  "eraseOwner takes options such as"          # src/server/erase.ts, behind src/server/store-api.ts
)
loaded_files() {
  local -A seen=(["$1"]=1)
  local queue=("$1") file chunk
  while [ ${#queue[@]} -gt 0 ]; do
    file="${queue[0]}"
    queue=("${queue[@]:1}")
    echo "dist/$file"
    for chunk in $(grep -oE '(import|from) *"\./[^"]+\.js"' "dist/$file" | grep -oE '[^"/]+\.js'); do
      if [ -z "${seen[$chunk]:-}" ]; then
        seen[$chunk]=1
        queue+=("$chunk")
      fi
    done
  done
}
mapfile -t SERVER_FILES < <(loaded_files index.js)
mapfile -t STORE_FILES < <(loaded_files store.js)
for marker in "${STORE_MARKERS[@]}"; do
  if ! grep -qF "$marker" "${STORE_FILES[@]}"; then
    echo "No file dist/store.js loads says \"$marker\". Update STORE_MARKERS in scripts/check-package.sh to a message of that module." >&2
    exit 1
  fi
  if found="$(grep -lF "$marker" "${SERVER_FILES[@]}")"; then
    echo "$found, which dist/index.js loads, carries the store's code (\"$marker\"). An endpoint must reach it through config.paths (src/store/paths.ts), never import it." >&2
    exit 1
  fi
done
# The built bin is what a project runs, and the tests run the source: its shebang, --help, --version and a usage
# error's exit code are checked here on Node and, when it is on PATH, on Bun (M11-R119). The runner's user agent is
# taken out of the environment, so the usage line is the one a direct start prints.
VERSION="$(node -p 'require("./package.json").version')"
if [ "$(head -n 1 dist/cli.js)" != "#!/usr/bin/env node" ]; then
  echo "dist/cli.js does not start with #!/usr/bin/env node. Check the first line of src/cli.ts." >&2
  exit 1
fi
if ! tar -tvzf "${TARBALL[0]}" package/dist/cli.js | grep -q '^-rwx'; then
  echo "dist/cli.js is not executable in the packed tarball. Check the cli build in tsdown.config.ts." >&2
  exit 1
fi
check_bin() {
  local runtime="$1" printed code
  printed="$(env -u npm_config_user_agent "$runtime" dist/cli.js --version)"
  if [ "$printed" != "$VERSION" ]; then
    echo "$runtime dist/cli.js --version printed \"$printed\", and package.json says $VERSION. Run bun run build." >&2
    exit 1
  fi
  if ! env -u npm_config_user_agent "$runtime" dist/cli.js --help | grep -q '^Usage: npx cloudrop <doctor|setup>'; then
    echo "$runtime dist/cli.js --help did not print the usage. Run it to see what it prints." >&2
    exit 1
  fi
  code=0
  "$runtime" dist/cli.js doctor >/dev/null 2>&1 || code=$?
  if [ "$code" != 2 ]; then
    echo "$runtime dist/cli.js doctor (no --origin) exited $code; a usage error exits 2." >&2
    exit 1
  fi
}
check_bin node
if command -v bun >/dev/null; then
  check_bin bun
fi
./node_modules/.bin/publint run "${TARBALL[0]}" --strict
# The package is ESM-only by decision. The esm-only profile leaves out the two resolutions that cannot load ESM at
# all, node10 and require() under node16; every rule stays on for node16 from ESM and for bundlers.
./node_modules/.bin/attw "${TARBALL[0]}" --profile esm-only --no-emoji
./node_modules/.bin/size-limit --config "$ROOT/scripts/size-limit.config.ts"
