#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?Usage: verify-coolify.sh <domain> [ssh_target]}"
SSH_TARGET="${2:-root@$HOST}"

echo "== HTTPS HEAD =="
curl -fsSIk "https://$HOST" | sed -n '1,12p'

echo
echo "== Containers =="
ssh "$SSH_TARGET" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

echo
echo "== Listening ports =="
ssh "$SSH_TARGET" "ss -tulpn | grep -E ':80|:443|:8000|:6001|:6002' || true"
