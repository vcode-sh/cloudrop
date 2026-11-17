#!/usr/bin/env bash
# Database lane: the store on Postgres 18 in Docker and on SQLite through node:sqlite (M5 spec §8). Generates the
# Prisma test clients, starts this run's Postgres container, then runs the `db` Vitest project
# (*.db.integration.test.ts); further arguments reach `vitest run`.
# The trap removes this run's container on success, failure and interrupt.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# An exact 18.x release, so every run and CI use the same server; bump it deliberately.
IMAGE=postgres:18.6
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running, and the database lane needs it for Postgres. Start Docker, then run the lane again." >&2
  exit 1
fi
PORT="${CLOUDROP_POSTGRES_PORT:-19500}"
if ss -ltnH "sport = :${PORT}" | grep -q .; then
  echo "Port ${PORT} is in use. Set CLOUDROP_POSTGRES_PORT to a free port." >&2
  exit 1
fi
NAME="cloudrop-test-postgres-$$"

cd packages/cloudrop
for schema in postgres sqlite; do
  bunx prisma generate --schema "src/testing/db/prisma/${schema}" >/dev/null
done
echo "Prisma test clients generated in packages/cloudrop/.prisma-client"

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
# Registered before `docker run` so a container that starts but never becomes ready is still removed. `-v` takes the
# image's anonymous volume with it; the data itself lives in a tmpfs.
remove_container() {
  if docker rm -f -v "$NAME" >/dev/null 2>&1; then
    echo "Postgres container ${NAME} removed"
  else
    echo "Could not remove the Postgres container ${NAME}. Remove it with: docker rm -f -v ${NAME}" >&2
  fi
}
trap remove_container EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# A disposable database: durability settings off for speed.
docker run -d --name "$NAME" --label cloudrop.test=postgres -p "127.0.0.1:${PORT}:5432" \
  --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=cloudrop -e POSTGRES_PASSWORD=cloudrop-test -e POSTGRES_DB=cloudrop \
  "$IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
# Over TCP inside the container: during first-time setup the image runs a temporary server on the Unix socket only.
ready=""
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U cloudrop -d cloudrop 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  echo "Postgres did not become ready within 60 seconds. Its log:" >&2
  docker logs --tail 30 "$NAME" >&2 || true
  exit 1
fi
echo "Postgres is listening on 127.0.0.1:${PORT}"

CLOUDROP_POSTGRES_URL="postgres://cloudrop:cloudrop-test@127.0.0.1:${PORT}/cloudrop" bunx vitest run --project db "$@"
