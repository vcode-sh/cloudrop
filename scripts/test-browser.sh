#!/usr/bin/env bash
# Browser lane: the Next.js example, built and started by Playwright, uploads from headless Chromium to a
# disposable RustFS container. The trap removes this run's container on success, failure and interrupt; Playwright
# stops the server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Not test-rustfs.sh's 19000, so both RustFS lanes can run at once with their defaults.
PORT="${CLOUDROP_RUSTFS_PORT:-19100}"
# The example always serves on 5173: the bucket's CORS rule names that origin.
if ss -ltnH "sport = :5173" | grep -q .; then
  echo "Port 5173 is in use. Stop what listens there; the example must serve on it." >&2
  exit 1
fi
if ss -ltnH "sport = :${PORT}" | grep -q .; then
  echo "Port ${PORT} is in use. Set CLOUDROP_RUSTFS_PORT to a free port." >&2
  exit 1
fi
export CLOUDROP_RUSTFS_PORT="$PORT"
export CLOUDROP_RUSTFS_NAME="cloudrop-browser-rustfs-$$"
# Registered before `up` so a container that starts but never becomes ready is still removed; `down` only touches
# this run's name.
trap '"$ROOT/scripts/rustfs.sh" down' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$ROOT/scripts/rustfs.sh" up
bun run build

# Exported, so they win over a developer's .env.local in `next build`, `next start` and the test's own storage.
CLOUDROP_SECRET="$(openssl rand -base64 32)"
export CLOUDROP_SECRET
export CLOUDROP_S3_ENDPOINT="http://127.0.0.1:${PORT}"
export CLOUDROP_S3_REGION=us-east-1
export CLOUDROP_S3_BUCKET=cloudrop-example
# The keys scripts/rustfs.sh starts the container with.
export CLOUDROP_S3_ACCESS_KEY_ID=cloudrop-test
export CLOUDROP_S3_SECRET_ACCESS_KEY=cloudrop-test-secret
export CLOUDROP_EXAMPLE_PREFIX=browser
# setup:rustfs then prepares the bucket and leaves any .env.local alone.
export CLOUDROP_SETUP_ENV_FILE=0
cd examples/next
bun run setup:rustfs
bunx playwright test
