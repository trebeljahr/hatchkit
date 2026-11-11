#!/usr/bin/env bash
set -euo pipefail

# In CI, the workflow provides MongoDB/Redis (services) and local S3 (a step).
# Locally, spin up Docker containers for E2E testing.
#
# Container names and ports are this project's own: e2e/infra.ts holds them
# and playwright.config.ts passes them in (E2E_STACK, E2E_*_PORT). So another
# project's run on this machine never reuses these containers, and this run
# never touches its. Every container started here carries the run's id as a
# label, and e2e/global-teardown.ts removes only those.

if [ -z "${CI:-}" ]; then
  : "${E2E_STACK:?not set: run the suite through Playwright (pnpm run test:e2e), which reads e2e/infra.ts}"
  echo "[e2e] Starting local test infrastructure (${E2E_STACK})..."

  # start_container <name> <docker run args...>
  # Reuses a running container of that name: it belongs to this project (the
  # name says so), started by an earlier run or by one still going, and the
  # run that started it removes it. A stopped one is replaced. Sets STARTED=1
  # when this run started the container.
  start_container() {
    local name="$1"
    shift
    STARTED=0
    case "$(docker container inspect -f '{{if .State.Running}}running{{else}}stopped{{end}}' "$name" 2>/dev/null || true)" in
      running)
        echo "[e2e] Reusing running container $name"
        return 0
        ;;
      stopped)
        docker rm "$name" >/dev/null
        ;;
    esac
    docker run -d --name "$name" --label "${E2E_RUN_LABEL}=${E2E_RUN_ID}" "$@" >/dev/null
    STARTED=1
  }

  # MongoDB
  start_container "${E2E_STACK}-mongo" -p "${E2E_MONGO_PORT}:27017" --tmpfs /data/db mongo:7
  if [ "$STARTED" = 1 ]; then
    echo "[e2e] Started MongoDB on port ${E2E_MONGO_PORT}"
  fi

  # Redis
  start_container "${E2E_STACK}-redis" -p "${E2E_REDIS_PORT}:6379" --tmpfs /data redis:7-alpine
  if [ "$STARTED" = 1 ]; then
    echo "[e2e] Started Redis on port ${E2E_REDIS_PORT}"
  fi

  # SeaweedFS S3
  start_container "${E2E_STACK}-seaweedfs" -p "${E2E_S3_PORT}:8333" \
    -e S3_BUCKET=starter-e2e \
    --tmpfs /data chrislusf/seaweedfs:4.47
  if [ "$STARTED" = 1 ]; then
    echo "[e2e] Started SeaweedFS S3 on port ${E2E_S3_PORT}"
  fi
  # Wait for SeaweedFS. The image creates S3_BUCKET on startup.
  for i in $(seq 1 60); do
    curl -sf -o /dev/null "http://127.0.0.1:${E2E_S3_PORT}/starter-e2e" && break
    sleep 1
  done
  echo "[e2e] SeaweedFS bucket ready"

  # Wait for MongoDB
  for i in $(seq 1 30); do
    node -e "
      const { MongoClient } = require('mongodb');
      MongoClient.connect('mongodb://127.0.0.1:${E2E_MONGO_PORT}')
        .then(c => { c.close(); process.exit(0); })
        .catch(() => process.exit(1));
    " 2>/dev/null && break
    sleep 1
  done
  echo "[e2e] MongoDB ready"

  # Wait for Redis
  for i in $(seq 1 10); do
    docker exec "${E2E_STACK}-redis" redis-cli ping 2>/dev/null | grep -q PONG && break
    sleep 1
  done
  echo "[e2e] Redis ready"
fi

echo "[e2e] Starting server..."
exec pnpm --filter @starter/server run dev
