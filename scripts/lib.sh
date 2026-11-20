# Helpers the lane scripts source: `source "$ROOT/scripts/lib.sh"`.

# Exits with a message when something already listens on the TCP port, so a lane never talks to another run's service:
#   require_free_port <port> <what to do instead>
require_free_port() {
  if ss -ltnH "sport = :$1" | grep -q .; then
    echo "Port $1 is in use. $2" >&2
    exit 1
  fi
}
