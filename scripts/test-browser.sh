#!/usr/bin/env bash
# Browser lane: the Next.js example, built and started by Playwright, uploads from headless Chromium to a
# disposable RustFS container, through the chaos proxy (scripts/chaos-proxy.ts) that the `*.chaos.browser.test.ts`
# rows fault through its control endpoint. The trap stops the proxy and removes this run's container on success,
# failure and interrupt; Playwright stops the server.
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
# The example's S3 endpoint: presigned URLs name the proxy, so the proxy's port is fixed for the whole run.
PROXY_PORT="${CLOUDROP_CHAOS_PROXY_PORT:-19110}"
if ss -ltnH "sport = :${PROXY_PORT}" | grep -q .; then
  echo "Port ${PROXY_PORT} is in use. Set CLOUDROP_CHAOS_PROXY_PORT to a free port." >&2
  exit 1
fi
export CLOUDROP_RUSTFS_PORT="$PORT"
export CLOUDROP_RUSTFS_NAME="cloudrop-browser-rustfs-$$"
export CLOUDROP_CHAOS_PROXY_PORT="$PROXY_PORT"
PROXY_PID=""
# One EXIT trap for both resources, since a second `trap … EXIT` would replace the first. Registered before `up` so a
# container that starts but never becomes ready is still removed; `down` only touches this run's name.
cleanup() {
  if [[ -n "$PROXY_PID" ]]; then
    kill "$PROXY_PID" 2>/dev/null || true
    echo "Chaos proxy stopped"
  fi
  "$ROOT/scripts/rustfs.sh" down
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$ROOT/scripts/rustfs.sh" up
# The proxy prints one line once both of its ports listen; the control URL is its last word. Its output stays open on
# descriptor 3 until the run ends, so a later write cannot fail on a closed pipe.
exec 3< <(exec node scripts/chaos-proxy.ts "http://127.0.0.1:${PORT}")
PROXY_PID=$!
if ! read -r -t 30 -u 3 READY; then
  echo "The chaos proxy did not start within 30 seconds; its error is above." >&2
  exit 1
fi
echo "$READY"
export CLOUDROP_CHAOS_CONTROL_URL="${READY##* }"
bun run build

# Exported, so they win over a developer's .env.local in `next build`, `next start` and the test's own storage.
CLOUDROP_SECRET="$(openssl rand -base64 32)"
export CLOUDROP_SECRET
export CLOUDROP_S3_ENDPOINT="http://127.0.0.1:${PROXY_PORT}"
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
# Arguments go to Playwright, for example one file: bun run test:browser lab.browser.test.ts
bunx playwright test "$@"
