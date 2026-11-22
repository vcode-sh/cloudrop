#!/usr/bin/env bash
# Runs the cloudrop/react unit tests (src/react.test.ts and src/react/**) against React 18, by default 18.3.1; the
# package promises `react >=18` and the workspace installs 19 (M12-R53). It works in a temporary copy of the package's
# source with its own install, so the workspace's install and bun.lock stay untouched; the copy is removed at the end.
# The test tools are pinned to the versions the workspace has installed, so run `bun install` first.
#   scripts/test-react-18.sh [react version]
# CLOUDROP_REACT_CHECK_DIR sets where the copy goes (CI: the runner's temp directory); the default is under the
# repository's git-ignored .superpowers/, never the OS temp directory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-18.3.1}"
DEST="${CLOUDROP_REACT_CHECK_DIR:-$ROOT/.superpowers/react-check}"
PACKAGE="$ROOT/packages/cloudrop"

if [[ -e "$DEST" ]]; then
  echo "$DEST already exists. Remove it, or set CLOUDROP_REACT_CHECK_DIR to a path that does not." >&2
  exit 1
fi
# Registered before the copy is made, so a failed install or run still removes it.
trap 'rm -rf "$DEST"' EXIT

# The installed version of each test tool the React tests import, besides react and react-dom.
installed() { node -p "require('$PACKAGE/node_modules/$1/package.json').version"; }
DEPENDENCIES=(vitest happy-dom @testing-library/react @testing-library/dom)
pins=""
for name in "${DEPENDENCIES[@]}"; do
  pins+="\"$name\": \"$(installed "$name")\", "
done

mkdir -p "$DEST"
cp -R "$PACKAGE/src" "$PACKAGE/tsconfig.json" "$DEST/"
cat >"$DEST/package.json" <<EOF
{ "name": "cloudrop-react-check", "private": true, "type": "module",
  "devDependencies": { ${pins}"react": "$VERSION", "react-dom": "$VERSION" } }
EOF
cd "$DEST"
bun install --ignore-scripts >/dev/null
echo "Running the React tests on react $(node -p "require('./node_modules/react/package.json').version") and react-dom $(node -p "require('./node_modules/react-dom/package.json').version")"
./node_modules/.bin/vitest run src/react.test.ts src/react/
echo "The React tests pass on React $VERSION"
