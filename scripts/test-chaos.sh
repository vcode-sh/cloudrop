#!/usr/bin/env bash
# Chaos lane: the real server and client on RustFS in Docker, behind the fault-injecting proxy each test file starts
# (packages/cloudrop/src/testing/chaos-fixture.ts). `scripts/test-chaos.sh` runs the `chaos` Vitest project,
# `scripts/test-chaos.sh soak` the nightly `soak` project; further arguments reach `vitest run`.
# The trap removes this run's container on success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PROJECT=chaos
if [[ "${1:-}" == "soak" ]]; then
  PROJECT=soak
  shift
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running, and the chaos lane needs it for RustFS. Start Docker, then run the lane again." >&2
  exit 1
fi
PORT="${CLOUDROP_RUSTFS_PORT:-19300}"
if ss -ltnH "sport = :${PORT}" | grep -q .; then
  echo "Port ${PORT} is in use. Set CLOUDROP_RUSTFS_PORT to a free port." >&2
  exit 1
fi
export CLOUDROP_RUSTFS_PORT="$PORT"
export CLOUDROP_RUSTFS_NAME="cloudrop-chaos-rustfs-$$"
# Registered before `up` so a container that starts but never becomes ready is still removed; `down` only touches this run's name.
trap '"$ROOT/scripts/rustfs.sh" down' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$ROOT/scripts/rustfs.sh" up
cd packages/cloudrop
CLOUDROP_RUSTFS_ENDPOINT="http://127.0.0.1:${PORT}" bunx vitest run --project "$PROJECT" "$@"
