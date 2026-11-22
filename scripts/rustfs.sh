#!/usr/bin/env bash
# Starts or stops this run's disposable RustFS container for the S3 contract lane.
# CLOUDROP_RUSTFS_NAME names the container (scripts/test-rustfs.sh makes it unique per run); CLOUDROP_RUSTFS_PORT the host port.
set -euo pipefail
NAME="${CLOUDROP_RUSTFS_NAME:-cloudrop-test-rustfs}"
PORT="${CLOUDROP_RUSTFS_PORT:-19000}"
case "${1:-}" in
  up)
    docker run -d --rm --name "$NAME" --label cloudrop.test=rustfs -p "127.0.0.1:${PORT}:9000" \
      -e RUSTFS_ACCESS_KEY=cloudrop-test -e RUSTFS_SECRET_KEY=cloudrop-test-secret \
      rustfs/rustfs:1.0.5 >/dev/null
    for _ in $(seq 1 60); do
      if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then
        echo "RustFS is listening on http://127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 1
    done
    echo "RustFS did not start within 60 seconds. Check: docker logs ${NAME}" >&2
    exit 1
    ;;
  down)
    # Manual removal must remove the image's anonymous /data volume too.
    docker rm -f -v "$NAME" >/dev/null 2>&1 || true
    echo "RustFS container ${NAME} removed"
    ;;
  *)
    echo "Usage: scripts/rustfs.sh up|down" >&2
    exit 2
    ;;
esac
