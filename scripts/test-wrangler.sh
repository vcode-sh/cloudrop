#!/usr/bin/env bash
# Wrangler local R2 contract lane. The trap stops the Wrangler this run started (by PID) and deletes its state on
# success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/cloudrop"
PORT="${CLOUDROP_WRANGLER_PORT:-18787}"
STATE=fixtures/wrangler/.state
SCRATCH=fixtures/wrangler/.wrangler
if ss -ltnH "sport = :${PORT}" | grep -q .; then
  echo "Port ${PORT} is in use. Set CLOUDROP_WRANGLER_PORT to a free port." >&2
  exit 1
fi
rm -rf "$STATE"
WRANGLER_PID=""
stop_wrangler() {
  if [ -n "$WRANGLER_PID" ]; then
    # Wrangler runs in its own session (setsid), so the group id is its pid: this also stops workerd.
    kill -- "-$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE" "$SCRATCH"
}
trap stop_wrangler EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
setsid ./node_modules/.bin/wrangler dev --config fixtures/wrangler/wrangler.jsonc --ip 127.0.0.1 --port "$PORT" \
  --persist-to "$STATE" --log-level warn &
WRANGLER_PID=$!
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then READY=1; break; fi
  sleep 1
done
if [ -z "${READY:-}" ]; then
  echo "Wrangler did not start within 60 seconds. Run it by hand to see why: packages/cloudrop/node_modules/.bin/wrangler dev --config fixtures/wrangler/wrangler.jsonc" >&2
  exit 1
fi
CLOUDROP_WRANGLER_ENDPOINT="http://127.0.0.1:${PORT}/cdn-cgi/local/r2/s3" \
  bunx vitest run --project integration src/storage/s3-driver.wrangler.integration.test.ts
