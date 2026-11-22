#!/usr/bin/env bash
# The Deno smoke lane (M12-P5): the packed tarball, unpacked as a project's node_modules/cloudrop, uploads one file on
# Deno through scripts/deno-smoke.ts, with no registry asked and no permission but reading the variables cloudrop
# reads (NODE_ENV and CLOUDROP_*). Run after `bun run build`.
#   CLOUDROP_DENO_DIR=<empty directory outside the repository> scripts/check-deno.sh
# The project sits outside the repository so that nothing resolves from the workspace's node_modules. CI uses
# $RUNNER_TEMP; the trap removes the project on success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$ROOT/packages/cloudrop"

if [[ -n "${CLOUDROP_DENO_DIR:-}" ]]; then
  DEST="$CLOUDROP_DENO_DIR"
elif [[ -n "${RUNNER_TEMP:-}" ]]; then
  DEST="$RUNNER_TEMP/deno-smoke"
else
  echo "Set CLOUDROP_DENO_DIR to a directory outside the repository, such as ../deno-smoke." >&2
  exit 1
fi
DEST="$(realpath -m "$DEST")"
if [[ "$DEST/" == "$ROOT/"* ]]; then
  echo "$DEST is inside the repository, where the workspace's packages would resolve. Choose a path outside it." >&2
  exit 1
fi
if [[ -e "$DEST" ]]; then
  echo "$DEST already exists. Remove it, or set CLOUDROP_DENO_DIR to a path that does not." >&2
  exit 1
fi
if [[ ! -f "$PACKAGE/dist/index.js" ]]; then
  echo "No build in packages/cloudrop/dist. Run bun run build first." >&2
  exit 1
fi
if ! command -v deno >/dev/null; then
  echo "deno is not on PATH. Install Deno 2 (https://docs.deno.com/runtime/getting_started/installation/)." >&2
  exit 1
fi
trap 'rm -rf "$DEST"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$DEST/node_modules/cloudrop"
(cd "$PACKAGE" && bun pm pack --destination "$DEST" --quiet >/dev/null)
tar -xzf "$DEST"/cloudrop-*.tgz -C "$DEST/node_modules/cloudrop" --strip-components=1
# cloudrop has no runtime dependency, so its unpacked tarball is the whole node_modules.
echo '{ "name": "cloudrop-deno-smoke", "private": true, "type": "module", "dependencies": { "cloudrop": "*" } }' \
  >"$DEST/package.json"
echo '{ "nodeModulesDir": "manual" }' >"$DEST/deno.json"
cp "$ROOT/scripts/deno-smoke.ts" "$DEST/smoke.ts"
cd "$DEST"
deno --version | head -n 1
deno run --no-prompt --no-remote --cached-only --allow-env=NODE_ENV,CLOUDROP_* smoke.ts
