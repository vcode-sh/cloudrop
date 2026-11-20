#!/usr/bin/env bash
# Starts or stops a disposable Postgres 18 container for the Hono example: `scripts/postgres.sh up|down`.
# CLOUDROP_EXAMPLE_POSTGRES_NAME names the container (default cloudrop-example-postgres, the example's dev database),
# CLOUDROP_EXAMPLE_POSTGRES_PORT its host port (default 19600; never 5432 or 55432, which this machine's own databases
# use). CLOUDROP_EXAMPLE_POSTGRES_TEST=1 labels it `cloudrop.test`, as the browser lane does, so a run's leftovers show
# in `docker ps -a --filter label=cloudrop.test`; the dev container carries no such label. The data lives in a tmpfs:
# `down` deletes it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
NAME="${CLOUDROP_EXAMPLE_POSTGRES_NAME:-cloudrop-example-postgres}"
PORT="${CLOUDROP_EXAMPLE_POSTGRES_PORT:-19600}"
# The db lane's exact release (scripts/test-db.sh), so one image serves both.
IMAGE=postgres:18.6
case "${1:-}" in
  up)
    require_free_port "$PORT" "Set CLOUDROP_EXAMPLE_POSTGRES_PORT to a free port."
    labels=()
    [[ "${CLOUDROP_EXAMPLE_POSTGRES_TEST:-}" == 1 ]] && labels=(--label cloudrop.test=postgres)
    docker run -d --rm --name "$NAME" "${labels[@]}" -p "127.0.0.1:${PORT}:5432" --tmpfs /var/lib/postgresql \
      -e POSTGRES_USER=cloudrop -e POSTGRES_PASSWORD=cloudrop-example -e POSTGRES_DB=cloudrop_example \
      "$IMAGE" >/dev/null
    # Over TCP inside the container: during first-time setup the image runs a temporary server on the Unix socket only.
    for _ in $(seq 1 60); do
      if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U cloudrop -d cloudrop_example 2>/dev/null; then
        echo "Postgres is listening on 127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 1
    done
    echo "Postgres did not become ready within 60 seconds. Check: docker logs ${NAME}" >&2
    exit 1
    ;;
  down)
    docker rm -f -v "$NAME" >/dev/null 2>&1 || true
    echo "Postgres container ${NAME} removed"
    ;;
  *)
    echo "Usage: scripts/postgres.sh up|down" >&2
    exit 2
    ;;
esac
