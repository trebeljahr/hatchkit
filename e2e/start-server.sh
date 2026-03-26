#!/usr/bin/env bash
set -euo pipefail

# In CI, GitHub Actions services provide MongoDB/Redis/MinIO.
# Locally, spin up Docker containers for E2E testing.

if [ -z "${CI:-}" ]; then
  echo "[e2e] Starting local test infrastructure..."

  # MongoDB on port 27018
  if ! docker ps --format '{{.Names}}' | grep -q starter-e2e-mongo; then
    docker run -d --name starter-e2e-mongo -p 27018:27017 --tmpfs /data/db mongo:7
    echo "[e2e] Started MongoDB on port 27018"
  fi

  # Redis on port 6380
  if ! docker ps --format '{{.Names}}' | grep -q starter-e2e-redis; then
    docker run -d --name starter-e2e-redis -p 6380:6379 --tmpfs /data redis:7-alpine
    echo "[e2e] Started Redis on port 6380"
  fi

  # MinIO on port 9002
  if ! docker ps --format '{{.Names}}' | grep -q starter-e2e-minio; then
    docker run -d --name starter-e2e-minio -p 9002:9000 \
      -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
      --tmpfs /data minio/minio:latest server /data
    echo "[e2e] Started MinIO on port 9002"

    # Wait for MinIO and create bucket
    for i in $(seq 1 30); do
      curl -sf http://127.0.0.1:9002/minio/health/live && break
      sleep 1
    done
    docker run --rm --network host \
      --entrypoint sh minio/mc:latest -c \
      "mc alias set local http://127.0.0.1:9002 minioadmin minioadmin && \
       mc mb --ignore-existing local/starter-e2e && \
       mc anonymous set download local/starter-e2e"
    echo "[e2e] MinIO bucket created"
  fi

  # Wait for MongoDB
  for i in $(seq 1 30); do
    node -e "
      const { MongoClient } = require('mongodb');
      MongoClient.connect('mongodb://127.0.0.1:27018')
        .then(c => { c.close(); process.exit(0); })
        .catch(() => process.exit(1));
    " 2>/dev/null && break
    sleep 1
  done
  echo "[e2e] MongoDB ready"

  # Wait for Redis
  for i in $(seq 1 10); do
    docker exec starter-e2e-redis redis-cli ping 2>/dev/null | grep -q PONG && break
    sleep 1
  done
  echo "[e2e] Redis ready"
fi

echo "[e2e] Starting server..."
exec pnpm --filter @starter/server run dev
