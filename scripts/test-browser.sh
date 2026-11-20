#!/usr/bin/env bash
# Browser lane: the Next.js example, built and started by Playwright, uploads from headless Chromium to a
# disposable RustFS container, through the chaos proxy (scripts/chaos-proxy.ts) that the `*.chaos.browser.test.ts`
# rows fault through its control endpoint. Playwright runs three times: the stateless example with every row but the
# store rows, then the example with a database store (CLOUDROP_EXAMPLE_STORE) with the store rows alone, then the Vite
# app (examples/vite-react) and the Hono API (examples/hono) on this run's own Postgres container, straight to RustFS.
# The trap stops the proxy, removes this run's containers and its store database on success, failure and interrupt;
# Playwright stops the servers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib.sh"
cd "$ROOT"
# Not test-rustfs.sh's 19000, so both RustFS lanes can run at once with their defaults.
PORT="${CLOUDROP_RUSTFS_PORT:-19100}"
# The example always serves on 5173: the bucket's CORS rule names that origin.
require_free_port 5173 "Stop what listens there; the example must serve on it."
require_free_port "$PORT" "Set CLOUDROP_RUSTFS_PORT to a free port."
# The example's S3 endpoint: presigned URLs name the proxy, so the proxy's port is fixed for the whole run.
PROXY_PORT="${CLOUDROP_CHAOS_PROXY_PORT:-19110}"
require_free_port "$PROXY_PORT" "Set CLOUDROP_CHAOS_PROXY_PORT to a free port."
# The Hono example's API serves on 5181, which the Vite app calls; its Postgres gets a port of its own.
require_free_port 5181 "Stop what listens there; the Hono API must serve on it."
POSTGRES_PORT="${CLOUDROP_EXAMPLE_POSTGRES_PORT:-19610}"
require_free_port "$POSTGRES_PORT" "Set CLOUDROP_EXAMPLE_POSTGRES_PORT to a free port."
export CLOUDROP_RUSTFS_PORT="$PORT"
export CLOUDROP_RUSTFS_NAME="cloudrop-browser-rustfs-$$"
export CLOUDROP_CHAOS_PROXY_PORT="$PROXY_PORT"
export CLOUDROP_EXAMPLE_POSTGRES_PORT="$POSTGRES_PORT"
export CLOUDROP_EXAMPLE_POSTGRES_NAME="cloudrop-browser-postgres-$$"
PROXY_PID=""
# The store pass's database: this run's own, in the example's git-ignored .data/.
STORE_DB="$ROOT/examples/next/.data/browser-$$.db"
# One EXIT trap for both resources, since a second `trap … EXIT` would replace the first. Registered before `up` so a
# container that starts but never becomes ready is still removed; `down` only touches this run's name.
cleanup() {
  if [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null; then
    echo "Chaos proxy stopped"
  fi
  rm -f "$STORE_DB" "$STORE_DB-journal"
  "$ROOT/scripts/rustfs.sh" down
  "$ROOT/scripts/postgres.sh" down
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$ROOT/scripts/rustfs.sh" up
# The proxy prints one line once both of its ports listen; the control URL is its last word. Its output stays open on
# descriptor 3 until the run ends, so a later write cannot fail on a closed pipe.
exec 3< <(exec node scripts/chaos-proxy.ts "http://127.0.0.1:${PORT}")
PROXY_PID=$!
# read ends above 128 when it times out, and with 1 when the proxy exits before printing.
READ_STATUS=0
read -r -t 30 -u 3 READY || READ_STATUS=$?
if ((READ_STATUS > 128)); then
  echo "The chaos proxy printed nothing within 30 seconds. Run node scripts/chaos-proxy.ts to see why." >&2
  exit 1
elif ((READ_STATUS != 0)); then
  echo "The chaos proxy exited before it was ready; its error is above." >&2
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
# Arguments go to both passes, for example one file: bun run test:browser lab.browser.test.ts. Only then may a pass
# select nothing (the file belongs to the other pass); without arguments an empty pass fails the lane.
bunx playwright test ${1:+--pass-with-no-tests} "$@"
# A quota of 50 MB: the store rows' refusal sends a 51 MiB file.
CLOUDROP_EXAMPLE_STORE="$STORE_DB" CLOUDROP_EXAMPLE_QUOTA_MB=50 bunx playwright test ${1:+--pass-with-no-tests} "$@"

# The Vite app and the Hono API. The API talks to RustFS directly, not through the proxy: no chaos rows here. Its quota
# is 50 MB, so the quota row's 51 MiB file never fits.
cd "$ROOT"
CLOUDROP_EXAMPLE_POSTGRES_TEST=1 scripts/postgres.sh up
export DATABASE_URL="postgres://cloudrop:cloudrop-example@127.0.0.1:${POSTGRES_PORT}/cloudrop_example"
BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export BETTER_AUTH_SECRET
export CLOUDROP_S3_ENDPOINT="http://127.0.0.1:${PORT}"
export CLOUDROP_S3_BUCKET=cloudrop-example-hono
export UPLOAD_QUOTA_MB=50
(cd examples/hono && bun run setup:rustfs && bun run db:migrate)
cd examples/vite-react
bunx playwright test ${1:+--pass-with-no-tests} "$@"
