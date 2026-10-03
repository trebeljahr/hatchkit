#!/bin/sh
set -eu

drain_seconds=${SHUTDOWN_DRAIN_SECONDS:-20}
case "$drain_seconds" in
  ''|*[!0-9]*)
    echo "SHUTDOWN_DRAIN_SECONDS must be a non-negative integer" >&2
    exit 1
    ;;
esac

marker=/tmp/hatchkit-site-draining
rm -f "$marker"

drain() {
  trap '' TERM INT
  touch "$marker"
  sleep "$drain_seconds"
  # QUIT lets accepted requests finish. Keep PID 1 alive until the master
  # exits; leaving the interrupted wait would kill its remaining workers.
  kill -QUIT "$nginx_pid" 2>/dev/null || true
  status=0
  wait "$nginx_pid" || status=$?
  exit "$status"
}

/docker-entrypoint.sh "$@" &
nginx_pid=$!
trap drain TERM INT
status=0
wait "$nginx_pid" || status=$?
exit "$status"
