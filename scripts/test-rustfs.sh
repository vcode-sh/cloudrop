#!/usr/bin/env bash
# RustFS contract lane. The trap removes this run's container on success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${CLOUDROP_RUSTFS_PORT:-19000}"
if ss -ltnH "sport = :${PORT}" | grep -q .; then
  echo "Port ${PORT} is in use. Set CLOUDROP_RUSTFS_PORT to a free port." >&2
  exit 1
fi
export CLOUDROP_RUSTFS_PORT="$PORT"
export CLOUDROP_RUSTFS_NAME="cloudrop-test-rustfs-$$"
# Registered before `up` so a container that starts but never becomes ready is still removed; `down` only touches this run's name.
trap '"$ROOT/scripts/rustfs.sh" down' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$ROOT/scripts/rustfs.sh" up
cd packages/cloudrop
CLOUDROP_RUSTFS_ENDPOINT="http://127.0.0.1:${PORT}" bunx vitest run --project integration src/storage/s3-driver.rustfs.integration.test.ts
