#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o /tmp/coolify-install.sh
bash /tmp/coolify-install.sh

echo
echo "If the Coolify proxy fails to start with a ParseAddr(.../64) error,"
echo "run scripts/repair-coolify-network.sh on the server and then start the proxy again from the UI."
