#!/usr/bin/env bash
# Checks what npm would publish (`bun run package:check`, after `bun run build`): publint and attw read the packed
# tarball, size-limit the built entries. The tarball goes to a scratch directory that the trap removes on success,
# failure and interrupt.
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
./node_modules/.bin/publint run "${TARBALL[0]}" --strict
# The package is ESM-only by decision. The esm-only profile leaves out the two resolutions that cannot load ESM at
# all, node10 and require() under node16; every rule stays on for node16 from ESM and for bundlers.
./node_modules/.bin/attw "${TARBALL[0]}" --profile esm-only --no-emoji
./node_modules/.bin/size-limit --config "$ROOT/scripts/size-limit.config.ts"
