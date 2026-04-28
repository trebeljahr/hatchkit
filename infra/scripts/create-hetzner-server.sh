#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${NAME:-coolify-vps}"
IMAGE="${IMAGE:-ubuntu-24.04}"
TYPE="${TYPE:-cpx21}"
LOCATION="${LOCATION:-nbg1}"
SSH_KEY_NAME="${SSH_KEY_NAME:?Set SSH_KEY_NAME to the name of the SSH key in Hetzner Cloud.}"
USER_DATA_FILE="${USER_DATA_FILE:-$ROOT_DIR/cloud-init/ubuntu-24.04-coolify.yaml}"
LABELS="${LABELS:-role=coolify,env=production}"
FIREWALL="${FIREWALL:-}"

if ! command -v hcloud >/dev/null 2>&1; then
  echo "hcloud CLI is required. Install it first." >&2
  exit 1
fi

args=(
  server create
  --name "$NAME"
  --image "$IMAGE"
  --type "$TYPE"
  --location "$LOCATION"
  --ssh-key "$SSH_KEY_NAME"
  --user-data-from-file "$USER_DATA_FILE"
  --label "$LABELS"
)

if [[ -n "$FIREWALL" ]]; then
  args+=(--firewall "$FIREWALL")
fi

echo "+ hcloud ${args[*]}"
hcloud "${args[@]}"
