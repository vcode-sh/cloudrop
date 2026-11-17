#!/usr/bin/env bash
# Type-checks the Drizzle adapter and its tests (packages/cloudrop/tsconfig.drizzle.json) against another drizzle-orm
# release, by default the 1.0 release candidate the owner's app runs on (M5-T51). It works in a temporary copy of the
# package with its own install, so the workspace's install and bun.lock stay untouched; the copy is removed at the end.
# Every other dependency is pinned to the version the workspace has installed, so run `bun install` first.
#   scripts/check-drizzle-versions.sh [drizzle-orm version]
# CLOUDROP_DRIZZLE_CHECK_DIR sets where the copy goes (CI: the runner's temp directory); the default is under the
# repository's git-ignored .superpowers/, never the OS temp directory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-1.0.0-rc.5}"
DEST="${CLOUDROP_DRIZZLE_CHECK_DIR:-$ROOT/.superpowers/drizzle-check}"
PACKAGE="$ROOT/packages/cloudrop"

if [[ -e "$DEST" ]]; then
  echo "$DEST already exists. Remove it, or set CLOUDROP_DRIZZLE_CHECK_DIR to a path that does not." >&2
  exit 1
fi
# Registered before the copy is made, so a failed install or check still removes it.
trap 'rm -rf "$DEST"' EXIT

# The installed version of each package the adapter's files and tests import, besides drizzle-orm.
installed() { node -p "require('$PACKAGE/node_modules/$1/package.json').version"; }
DEPENDENCIES=(typescript vitest @types/node pg @types/pg postgres better-sqlite3 @types/better-sqlite3 @libsql/client)
pins=""
for name in "${DEPENDENCIES[@]}"; do
  pins+="\"$name\": \"$(installed "$name")\", "
done

mkdir -p "$DEST"
cp -R "$PACKAGE/src" "$PACKAGE/tsconfig.json" "$PACKAGE/tsconfig.test.json" "$PACKAGE/tsconfig.drizzle.json" "$DEST/"
cat >"$DEST/package.json" <<EOF
{ "name": "cloudrop-drizzle-check", "private": true, "type": "module",
  "devDependencies": { ${pins}"drizzle-orm": "$VERSION" } }
EOF
cd "$DEST"
# Types only: no native builds.
bun install --ignore-scripts >/dev/null
echo "Type-checking the Drizzle adapter against drizzle-orm $(node -p "require('./node_modules/drizzle-orm/package.json').version")"
./node_modules/.bin/tsc --noEmit -p tsconfig.drizzle.json
echo "The Drizzle adapter type-checks against drizzle-orm $VERSION"
