#!/usr/bin/env bash
set -euo pipefail

COOLIFY_DIR="/data/coolify/source"

if [[ ! -d "$COOLIFY_DIR" ]]; then
  echo "Coolify source directory not found at $COOLIFY_DIR" >&2
  exit 1
fi

cp "$COOLIFY_DIR/.env" "/root/coolify-env-backup-$(date +%F-%H%M%S).env"
docker network inspect coolify > "/root/coolify-network-before-fix-$(date +%F-%H%M%S).json"

docker compose \
  -f "$COOLIFY_DIR/docker-compose.yml" \
  -f "$COOLIFY_DIR/docker-compose.prod.yml" \
  --env-file "$COOLIFY_DIR/.env" \
  down

docker network rm coolify || true

docker network create \
  --driver bridge \
  --subnet 10.0.1.0/24 \
  --gateway 10.0.1.1 \
  coolify

docker compose \
  -f "$COOLIFY_DIR/docker-compose.yml" \
  -f "$COOLIFY_DIR/docker-compose.prod.yml" \
  --env-file "$COOLIFY_DIR/.env" \
  up -d

echo "Network repaired. Start or restart the Coolify proxy from the UI."
