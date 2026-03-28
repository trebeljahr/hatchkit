#!/usr/bin/env bash
# setup-coolify-stack.sh — Create a full app stack in Coolify via REST API.
#
# WHY A SCRIPT INSTEAD OF TERRAFORM?
# The Coolify Terraform provider (SierraJC/coolify) is still 0.x with partial
# support for applications and databases. The Coolify REST API, on the other
# hand, is complete and stable. This script uses it directly.
#
# Once the Terraform provider matures, you can replace this script with .tf
# files. The concepts map 1:1 (create project, create app, set env vars).
#
# WHAT IT CREATES:
# 1. A Coolify project (container for related apps/DBs)
# 2. MongoDB database (auto-wired via MONGODB_URI)
# 3. Redis database (optional, auto-wired via REDIS_URL)
# 4. The application with multi-domain routing:
#    - Frontend: https://<app-domain>
#    - Backend:  https://api.<app-domain>, https://<app-domain>/api,
#                https://<app-domain>/api/ws, https://api.<app-domain>/ws
# 5. Environment variables (including auto-wired DB connection strings)
# 6. GitHub Actions secrets (via gh CLI)
#
# PREREQUISITES:
# - Coolify is installed and accessible
# - You have a Coolify API token (Settings > API Tokens in the dashboard)
# - curl and jq are installed
# - gh CLI installed and authenticated (for GitHub secrets)
#
# USAGE:
#   ./scripts/setup-coolify-stack.sh --config stacks/myapp.env
#   # or interactively (it will prompt for missing values)

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()   { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()   { error "$@"; exit 1; }

# Make a Coolify API call. Handles auth header and base URL.
# Usage: coolify_api GET /applications
#        coolify_api POST /applications '{"name": "my-app"}'
coolify_api() {
  local method="$1"
  local endpoint="$2"
  local data="${3:-}"

  local args=(
    -s                                        # silent (no progress bar)
    -f                                        # fail on HTTP errors
    -H "Authorization: Bearer ${COOLIFY_TOKEN}"
    -H "Content-Type: application/json"
    -H "Accept: application/json"
    -X "$method"
  )

  if [[ -n "$data" ]]; then
    args+=(-d "$data")
  fi

  # GOTCHA: The -f flag makes curl return exit code 22 on HTTP 4xx/5xx.
  # We capture stderr to show the actual error body on failure.
  local response
  if ! response=$(curl "${args[@]}" "${COOLIFY_URL}/api/v1${endpoint}" 2>&1); then
    error "API call failed: $method $endpoint"
    error "Response: $response"
    return 1
  fi

  echo "$response"
}

# Prompt for a value if not already set. Uses a default if provided.
# Usage: prompt_var VARIABLE_NAME "Prompt text" "default_value"
prompt_var() {
  local var_name="$1"
  local prompt_text="$2"
  local default="${3:-}"
  local current_value="${!var_name:-}"

  if [[ -n "$current_value" ]]; then
    return  # already set (from env or config file)
  fi

  if [[ -n "$default" ]]; then
    read -rp "$prompt_text [$default]: " value
    value="${value:-$default}"
  else
    read -rp "$prompt_text: " value
    [[ -z "$value" ]] && die "Required value: $prompt_text"
  fi

  # Use printf -v to set a variable by name (like bash's nameref but portable)
  printf -v "$var_name" '%s' "$value"
}

# Set an environment variable on a Coolify application.
# Usage: set_app_env APP_UUID KEY VALUE [is_build_time]
set_app_env() {
  local app_uuid="$1"
  local key="$2"
  local value="$3"
  local is_build="${4:-false}"

  coolify_api POST "/applications/${app_uuid}/envs" "$(cat <<ENDJSON
{
  "key": "${key}",
  "value": "${value}",
  "is_preview": false,
  "is_build_time": ${is_build}
}
ENDJSON
)" >/dev/null

  ok "  ${key}=****"
}

# ---------------------------------------------------------------------------
# Load config file if provided
# ---------------------------------------------------------------------------

CONFIG_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --help|-h) echo "Usage: $0 [--config path/to/stack.env]"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [[ -n "$CONFIG_FILE" ]]; then
  [[ -f "$CONFIG_FILE" ]] || die "Config file not found: $CONFIG_FILE"
  log "Loading config from $CONFIG_FILE"
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
  # GOTCHA: `source` runs the file as bash. This means your .env file
  # could technically contain arbitrary commands. Only source files you trust.
fi

# ---------------------------------------------------------------------------
# Collect required values (from env, config file, or interactive prompt)
# ---------------------------------------------------------------------------

log "Collecting configuration..."

prompt_var COOLIFY_URL   "Coolify dashboard URL (e.g. https://admin.example.com)" ""
prompt_var COOLIFY_TOKEN "Coolify API token" ""

# Validate connectivity before asking more questions.
log "Checking Coolify API connectivity..."
if ! coolify_api GET /version >/dev/null 2>&1; then
  die "Cannot reach Coolify API at ${COOLIFY_URL}. Check URL and token."
fi
ok "Connected to Coolify at ${COOLIFY_URL}"

# Fetch available servers to let user pick one.
log "Fetching available servers..."
SERVERS=$(coolify_api GET /servers)
SERVER_COUNT=$(echo "$SERVERS" | jq 'length')

if [[ "$SERVER_COUNT" -eq 0 ]]; then
  die "No servers found in Coolify. Add a server in the dashboard first."
elif [[ "$SERVER_COUNT" -eq 1 ]]; then
  SERVER_UUID=$(echo "$SERVERS" | jq -r '.[0].uuid')
  SERVER_NAME_DISPLAY=$(echo "$SERVERS" | jq -r '.[0].name')
  log "Using server: $SERVER_NAME_DISPLAY ($SERVER_UUID)"
else
  echo ""
  echo "Available servers:"
  echo "$SERVERS" | jq -r '.[] | "  \(.uuid)  \(.name)"'
  prompt_var SERVER_UUID "Server UUID" ""
fi

prompt_var PROJECT_NAME     "Project name"           "myapp"
prompt_var ENVIRONMENT_NAME "Environment name"       "production"
prompt_var APP_NAME         "Application name"       "myapp-web"
prompt_var GITHUB_REPO_URL  "GitHub repository URL"  ""

# Database options
prompt_var MONGO_ENABLED "Create MongoDB? (yes/no)" "yes"
prompt_var REDIS_ENABLED "Create Redis? (yes/no)"   "no"

# S3-compatible object storage
# See the comment block below for why Hetzner Object Storage is the default.
prompt_var S3_PROVIDER "S3 storage provider (hetzner/r2/minio/custom/none)" "hetzner"

# Domain and port
prompt_var APP_DOMAIN "Application domain (e.g. myapp.example.com)" ""
prompt_var APP_PORT   "Application port" "3000"

# ---------------------------------------------------------------------------
# Derive API subdomain from APP_DOMAIN
# ---------------------------------------------------------------------------

# DOMAIN ROUTING STRATEGY:
#
# Your app gets served on multiple domains/paths so that the frontend
# and backend API can be reached cleanly:
#
#   Frontend:  https://myapp.example.com
#   Backend:   https://api.myapp.example.com        (dedicated API subdomain)
#              https://myapp.example.com/api         (path-based alternative)
#              https://myapp.example.com/api/ws      (WebSocket via path)
#              https://api.myapp.example.com/ws      (WebSocket via subdomain)
#
# WHY BOTH subdomain AND path-based?
# - The subdomain (api.xxx) is clean for external consumers and CORS config.
# - The path-based (/api) keeps everything on the same origin, which avoids
#   CORS entirely for the frontend — browsers treat same-origin requests
#   differently (no preflight, cookies sent automatically).
# - WebSocket endpoints on both so clients can connect either way.
#
# Coolify's `domains` field accepts a comma-separated list. Traefik (the
# reverse proxy Coolify uses) will route ALL listed domains to this container.
# Path-based routing (/api, /api/ws) is handled INSIDE your app (Express
# router), not by Traefik — Traefik just forwards the full URL.

API_DOMAIN="api.${APP_DOMAIN}"

# The domains string Coolify needs. All of these route to the same container.
# Your Express app decides what to do based on the Host header and path.
APP_DOMAINS="https://${API_DOMAIN},https://${APP_DOMAIN}/api,https://${APP_DOMAIN}/api/ws,https://${API_DOMAIN}/ws"

# For the frontend, we also need the base domain.
# We combine everything into one domains list for the single container.
# The app is deployed as ONE container (frontend + backend together).
ALL_DOMAINS="https://${APP_DOMAIN},${APP_DOMAINS}"

log "Domain routing:"
log "  Frontend: https://${APP_DOMAIN}"
log "  Backend:  ${APP_DOMAINS}"

# ---------------------------------------------------------------------------
# Step 1: Create project
# ---------------------------------------------------------------------------

log "Creating project: $PROJECT_NAME"
PROJECT=$(coolify_api POST /projects "{\"name\": \"${PROJECT_NAME}\"}")
PROJECT_UUID=$(echo "$PROJECT" | jq -r '.uuid')
ok "Project created: $PROJECT_UUID"

# Every project has environments (like production, staging).
# Get the default environment, or the one matching our name.
log "Fetching project environments..."
ENVS=$(coolify_api GET "/projects/${PROJECT_UUID}/environments")
ENV_NAME=$(echo "$ENVS" | jq -r ".[0].name")
ok "Using environment: $ENV_NAME"

# ---------------------------------------------------------------------------
# Step 2: Create databases
# ---------------------------------------------------------------------------

# MONGODB
MONGO_INTERNAL_URL=""
MONGO_UUID=""

if [[ "${MONGO_ENABLED}" == "yes" ]]; then
  log "Creating MongoDB database..."

  MONGO_PAYLOAD=$(cat <<ENDJSON
{
  "server_uuid": "${SERVER_UUID}",
  "project_uuid": "${PROJECT_UUID}",
  "environment_name": "${ENV_NAME}",
  "type": "mongodb",
  "name": "${PROJECT_NAME}-mongo",
  "image": "mongo:7"
}
ENDJSON
)

  # GOTCHA: The Coolify API for database creation might vary between versions.
  # The endpoint and payload structure can change. If this fails, check the
  # Coolify API docs at https://coolify.io/docs/api-reference
  MONGO=$(coolify_api POST /databases "$MONGO_PAYLOAD") || {
    warn "Database creation via /databases endpoint failed."
    warn "Your Coolify version may use a different endpoint."
    warn "You can create the database manually in the dashboard."
    MONGO_ENABLED="no"
  }

  if [[ "${MONGO_ENABLED}" == "yes" ]]; then
    MONGO_UUID=$(echo "$MONGO" | jq -r '.uuid')
    ok "MongoDB created: $MONGO_UUID"

    # AUTO-WIRING: Coolify puts all resources in a project on the same Docker
    # network. Containers can reach each other by their Coolify-assigned name.
    # So the app container can connect to MongoDB at:
    #   mongodb://<container-name>:27017/<db-name>
    # No credentials by default — Coolify's MongoDB doesn't set auth unless
    # you configure it. For production, you should add MONGO_INITDB_ROOT_USERNAME
    # and MONGO_INITDB_ROOT_PASSWORD via the Coolify dashboard on the DB resource.
    MONGO_INTERNAL_URL="mongodb://${PROJECT_NAME}-mongo:27017/${PROJECT_NAME}"
    log "Auto-wired MONGODB_URI: $MONGO_INTERNAL_URL"
  fi
fi

# REDIS
REDIS_INTERNAL_URL=""
REDIS_UUID=""

if [[ "${REDIS_ENABLED}" == "yes" ]]; then
  log "Creating Redis database..."

  REDIS_PAYLOAD=$(cat <<ENDJSON
{
  "server_uuid": "${SERVER_UUID}",
  "project_uuid": "${PROJECT_UUID}",
  "environment_name": "${ENV_NAME}",
  "type": "redis",
  "name": "${PROJECT_NAME}-redis",
  "image": "redis:7-alpine"
}
ENDJSON
)

  REDIS=$(coolify_api POST /databases "$REDIS_PAYLOAD") || {
    warn "Redis creation failed. You can create it manually in the dashboard."
    REDIS_ENABLED="no"
  }

  if [[ "${REDIS_ENABLED}" == "yes" ]]; then
    REDIS_UUID=$(echo "$REDIS" | jq -r '.uuid')
    ok "Redis created: $REDIS_UUID"

    # Same auto-wiring as MongoDB. Redis default port is 6379, no auth by default.
    # For production, set a password via the Coolify dashboard on the Redis resource
    # and update REDIS_URL to include it: redis://:password@host:6379
    REDIS_INTERNAL_URL="redis://${PROJECT_NAME}-redis:6379"
    log "Auto-wired REDIS_URL: $REDIS_INTERNAL_URL"
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Create the application
# ---------------------------------------------------------------------------

log "Creating application: $APP_NAME"

# Coolify has different endpoints depending on how you authenticate with GitHub:
# - /applications/public  = public repos (no auth needed)
# - /applications/private-github-app = private repos via GitHub App
# - /applications/private-deploy-key = private repos via deploy key

# We use the public endpoint. For private repos, you need a GitHub App
# configured in Coolify first (Sources page in the dashboard).
APP_PAYLOAD=$(cat <<ENDJSON
{
  "server_uuid": "${SERVER_UUID}",
  "project_uuid": "${PROJECT_UUID}",
  "environment_name": "${ENV_NAME}",
  "name": "${APP_NAME}",
  "git_repository": "${GITHUB_REPO_URL}",
  "git_branch": "main",
  "build_pack": "dockerfile",
  "ports_exposes": "${APP_PORT}",
  "domains": "${ALL_DOMAINS}"
}
ENDJSON
)

APP=$(coolify_api POST /applications/public "$APP_PAYLOAD") || {
  warn "Public repo creation failed. If this is a private repo, you need a"
  warn "GitHub App configured in Coolify. Create the app manually, then"
  warn "re-run this script with just the env vars step."
  die "Application creation failed."
}

APP_UUID=$(echo "$APP" | jq -r '.uuid')
ok "Application created: $APP_UUID"

# ---------------------------------------------------------------------------
# Step 4: Extract webhook URL and set GitHub repo secrets
# ---------------------------------------------------------------------------

WEBHOOK_URL="${COOLIFY_URL}/api/v1/deploy?uuid=${APP_UUID}&force=false"

# Convert the full GitHub URL to the owner/repo format that `gh` expects.
# Handles both https://github.com/owner/repo.git and https://github.com/owner/repo
GITHUB_REPO_SLUG="${GITHUB_REPO_URL#https://github.com/}"
GITHUB_REPO_SLUG="${GITHUB_REPO_SLUG%.git}"

if ! command -v gh >/dev/null 2>&1; then
  warn "gh CLI not found — cannot set GitHub secrets automatically."
  warn "Install it: https://cli.github.com"
  warn "Then re-run, or set secrets manually:"
  echo ""
  echo "  gh secret set COOLIFY_WEBHOOK_URL -R ${GITHUB_REPO_SLUG} --body '...'"
  echo "  gh secret set COOLIFY_TOKEN       -R ${GITHUB_REPO_SLUG} --body '...'"
  echo ""
else
  # Ensure the user is authenticated with GitHub before we try to set secrets.
  if ! gh auth status >/dev/null 2>&1; then
    warn "You are not logged in to GitHub via the gh CLI."
    log "Running 'gh auth login' now — follow the prompts to authenticate."
    echo ""

    # gh auth login is interactive — it walks the user through OAuth or
    # token-based auth. We let it take over the terminal. If they cancel
    # (Ctrl+C), set -e will exit the whole script, which is fine — they
    # can re-run after authenticating separately.
    gh auth login

    # Verify it actually worked (user might have cancelled partway).
    if ! gh auth status >/dev/null 2>&1; then
      warn "GitHub authentication did not complete. Skipping secret setup."
      warn "Run 'gh auth login' and then re-run this script."
    fi
  fi

  # Only proceed if we're now authenticated.
  if gh auth status >/dev/null 2>&1; then
    log "Setting GitHub Actions secrets on ${GITHUB_REPO_SLUG}..."

    if gh secret set COOLIFY_WEBHOOK_URL \
        --body "$WEBHOOK_URL" \
        --repo "$GITHUB_REPO_SLUG" 2>/dev/null; then
      ok "Set COOLIFY_WEBHOOK_URL on ${GITHUB_REPO_SLUG}"
    else
      warn "Failed to set COOLIFY_WEBHOOK_URL. Check repo permissions."
      warn "Manual: gh secret set COOLIFY_WEBHOOK_URL -R ${GITHUB_REPO_SLUG}"
    fi

    if gh secret set COOLIFY_TOKEN \
        --body "$COOLIFY_TOKEN" \
        --repo "$GITHUB_REPO_SLUG" 2>/dev/null; then
      ok "Set COOLIFY_TOKEN on ${GITHUB_REPO_SLUG}"
    else
      warn "Failed to set COOLIFY_TOKEN. Check repo permissions."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 5: Validate domain DNS
# ---------------------------------------------------------------------------

log "Checking DNS for ${APP_DOMAIN} and ${API_DOMAIN}..."
for domain_to_check in "$APP_DOMAIN" "$API_DOMAIN"; do
  if command -v dig >/dev/null 2>&1; then
    RESOLVED_IP=$(dig +short "$domain_to_check" A 2>/dev/null | head -1)
    if [[ -z "$RESOLVED_IP" ]]; then
      warn "${domain_to_check} does not resolve yet."
      warn "Make sure your Terraform subdomains include this, or add the DNS record."
    else
      ok "${domain_to_check} resolves to ${RESOLVED_IP}"
    fi
  elif command -v host >/dev/null 2>&1; then
    if host "$domain_to_check" >/dev/null 2>&1; then
      ok "${domain_to_check} resolves"
    else
      warn "${domain_to_check} does not resolve yet."
    fi
  else
    log "Skipping DNS check (neither dig nor host available)"
    break
  fi
done

# ---------------------------------------------------------------------------
# Step 6: Set environment variables
# ---------------------------------------------------------------------------

log "Setting environment variables on the application..."

set_app_env "$APP_UUID" "NODE_ENV"      "production"
set_app_env "$APP_UUID" "PORT"          "$APP_PORT"
set_app_env "$APP_UUID" "FRONTEND_URL"  "https://${APP_DOMAIN}"

# Auto-wire database connection strings.
# These are internal Docker network URLs — they only work between containers
# on the same Coolify server. They're not reachable from your laptop.
if [[ -n "$MONGO_INTERNAL_URL" ]]; then
  set_app_env "$APP_UUID" "MONGODB_URI" "$MONGO_INTERNAL_URL"
fi

if [[ -n "$REDIS_INTERNAL_URL" ]]; then
  set_app_env "$APP_UUID" "REDIS_URL" "$REDIS_INTERNAL_URL"
fi

# ---------------------------------------------------------------------------
# Step 7: S3 storage configuration
# ---------------------------------------------------------------------------

# S3 STORAGE: WHAT ARE YOUR OPTIONS?
#
# Option 1: Hetzner Object Storage (RECOMMENDED for your setup)
#   - 4.99 EUR/month for 1 TB storage + 1 TB egress
#   - S3-compatible API, same datacenter as your server = fast
#   - No container to manage, no disk space used on your VPS
#   - Create a bucket in Hetzner Cloud console, get credentials there
#   - Endpoint: https://<location>.your-objectstorage.com
#
# Option 2: Cloudflare R2
#   - 10 GB free, then $0.015/GB/month storage
#   - Zero egress fees (the big selling point)
#   - Good if you serve lots of assets publicly (images, videos)
#   - Endpoint: https://<account-id>.r2.cloudflarestorage.com
#
# Option 3: MinIO on the box
#   - Free, but uses VPS disk space and RAM (~200-400 MB)
#   - On a cpx21 (4 GB RAM) with MongoDB + Redis + app, it's tight
#   - Good for dev/staging, not great for production on small boxes
#   - If the VPS dies, your objects die with it (unless you set up replication)
#
# Option 4: AWS S3
#   - The original, but most expensive for egress
#   - Only makes sense if you're already in the AWS ecosystem
#
# RECOMMENDATION: Hetzner Object Storage.
#   Same provider, same region, cheapest, and zero operational overhead.
#   MinIO only makes sense if you need to avoid any external dependency
#   or are doing heavy local dev testing.

echo ""
log "Configuring S3 storage (provider: ${S3_PROVIDER})..."

case "$S3_PROVIDER" in
  hetzner)
    log "Using Hetzner Object Storage."

    # TRY TO AUTO-PULL FROM TERRAFORM OUTPUT.
    # If you ran `terraform apply` first (which creates the bucket), we can
    # read the bucket name, endpoint, and region directly from Terraform state.
    # This avoids you having to type them again and prevents mismatches.
    #
    # HOW THIS WORKS:
    # `terraform output -raw <name>` reads a value from the state file.
    # We look for the Terraform stack directory relative to this script.
    # If it doesn't exist or has no state, we fall back to prompting.

    ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    TF_DIR="${ROOT_DIR}/terraform/stacks/${PROJECT_NAME}"
    TF_AVAILABLE=false

    if [[ -d "$TF_DIR" ]] && [[ -f "$TF_DIR/terraform.tfstate" || -d "$TF_DIR/.terraform" ]]; then
      log "Found Terraform state at ${TF_DIR}, reading S3 outputs..."
      if TF_S3_BUCKET=$(cd "$TF_DIR" && terraform output -raw s3_bucket 2>/dev/null) && [[ -n "$TF_S3_BUCKET" ]]; then
        TF_S3_ENDPOINT=$(cd "$TF_DIR" && terraform output -raw s3_endpoint 2>/dev/null)
        TF_S3_REGION=$(cd "$TF_DIR" && terraform output -raw s3_region 2>/dev/null)
        ok "Auto-read from Terraform: bucket=${TF_S3_BUCKET}, endpoint=${TF_S3_ENDPOINT}"
        TF_AVAILABLE=true

        # Use Terraform values as defaults (user can still override via .env).
        : "${S3_BUCKET:=$TF_S3_BUCKET}"
        : "${S3_ENDPOINT:=$TF_S3_ENDPOINT}"
        : "${S3_REGION:=$TF_S3_REGION}"
      else
        log "No S3 outputs in Terraform state (s3_enabled may be false). Prompting manually."
      fi
    fi

    # Prompt for anything still missing. If Terraform filled them in, the
    # prompt_var function sees they're already set and skips the prompt.
    prompt_var S3_BUCKET      "S3 bucket name" "${PROJECT_NAME}-assets"
    prompt_var S3_ENDPOINT    "Hetzner S3 endpoint (e.g. https://nbg1.your-objectstorage.com)" ""
    prompt_var S3_REGION      "S3 region" "nbg1"

    # S3 credentials — these are NOT in Terraform output (they're sensitive).
    # The same credentials you passed to Terraform as TF_VAR_s3_access_key
    # are the ones your app needs. We check if they're in the environment.
    : "${S3_ACCESS_KEY:=$TF_VAR_s3_access_key}"
    : "${S3_SECRET_KEY:=$TF_VAR_s3_secret_key}"
    prompt_var S3_ACCESS_KEY  "S3 access key" ""
    prompt_var S3_SECRET_KEY  "S3 secret key" ""

    # Hetzner Object Storage doesn't use CloudFront. The public URL is just
    # the endpoint + bucket + key path. If you put a CDN in front (e.g.
    # Cloudflare), set PUBLIC_ASSET_URL to that CDN domain.
    prompt_var PUBLIC_ASSET_URL "Public asset base URL (or leave empty to use endpoint directly)" ""
    if [[ -z "$PUBLIC_ASSET_URL" ]]; then
      PUBLIC_ASSET_URL="${S3_ENDPOINT}/${S3_BUCKET}"
    fi
    ;;
  r2)
    log "Using Cloudflare R2."
    log "Create a bucket at https://dash.cloudflare.com → R2"
    echo ""
    prompt_var S3_BUCKET      "R2 bucket name" "${PROJECT_NAME}-assets"
    prompt_var S3_ENDPOINT    "R2 endpoint (https://<account-id>.r2.cloudflarestorage.com)" ""
    prompt_var S3_ACCESS_KEY  "R2 access key" ""
    prompt_var S3_SECRET_KEY  "R2 secret key" ""
    S3_REGION="auto"  # R2 uses "auto" as region
    prompt_var PUBLIC_ASSET_URL "R2 public bucket URL or custom domain" ""
    ;;
  minio)
    log "Using MinIO on the same server."
    log "Make sure MinIO is deployed as a Coolify Service first."
    echo ""
    prompt_var S3_BUCKET      "MinIO bucket name" "${PROJECT_NAME}-assets"
    # MinIO on the same Docker network is reachable by its container name.
    prompt_var S3_ENDPOINT    "MinIO endpoint" "http://${PROJECT_NAME}-minio:9000"
    prompt_var S3_ACCESS_KEY  "MinIO root user" ""
    prompt_var S3_SECRET_KEY  "MinIO root password" ""
    S3_REGION="us-east-1"  # MinIO default, doesn't matter
    prompt_var PUBLIC_ASSET_URL "Public MinIO URL (if exposed via domain)" ""
    ;;
  custom)
    prompt_var S3_BUCKET      "S3 bucket name" ""
    prompt_var S3_ENDPOINT    "S3 endpoint URL" ""
    prompt_var S3_ACCESS_KEY  "S3 access key ID" ""
    prompt_var S3_SECRET_KEY  "S3 secret access key" ""
    prompt_var S3_REGION      "S3 region" "eu-central-1"
    prompt_var PUBLIC_ASSET_URL "Public asset base URL" ""
    ;;
  none)
    log "Skipping S3 storage setup."
    ;;
  *)
    warn "Unknown S3 provider: ${S3_PROVIDER}. Skipping."
    S3_PROVIDER="none"
    ;;
esac

if [[ "$S3_PROVIDER" != "none" ]]; then
  set_app_env "$APP_UUID" "S3_BUCKET_NAME"        "$S3_BUCKET"
  set_app_env "$APP_UUID" "S3_ENDPOINT"            "$S3_ENDPOINT"
  set_app_env "$APP_UUID" "AWS_ACCESS_KEY_ID"      "$S3_ACCESS_KEY"
  set_app_env "$APP_UUID" "AWS_SECRET_ACCESS_KEY"  "$S3_SECRET_KEY"
  set_app_env "$APP_UUID" "AWS_REGION"             "$S3_REGION"
  set_app_env "$APP_UUID" "PUBLIC_ASSET_URL"       "$PUBLIC_ASSET_URL"
fi

# ---------------------------------------------------------------------------
# Step 8: App-specific secrets
# ---------------------------------------------------------------------------

echo ""
log "Setting app-specific secrets..."
log "These are stored in Coolify (encrypted at rest), not in any local file."
echo ""

prompt_var TOKEN_SECRET "TOKEN_SECRET (JWT signing key)" ""
prompt_var ALTCHA_HMAC  "ALTCHA_HMAC_KEY" ""

set_app_env "$APP_UUID" "TOKEN_SECRET"    "$TOKEN_SECRET"
set_app_env "$APP_UUID" "ALTCHA_HMAC_KEY" "$ALTCHA_HMAC"

# ---------------------------------------------------------------------------
# Done!
# ---------------------------------------------------------------------------

echo ""
echo "============================================"
ok "Stack setup complete!"
echo "============================================"
echo ""
echo "  Project:     $PROJECT_NAME ($PROJECT_UUID)"
echo "  Application: $APP_NAME ($APP_UUID)"
[[ -n "$MONGO_UUID" ]] && echo "  MongoDB:     ${PROJECT_NAME}-mongo ($MONGO_UUID)"
[[ -n "$REDIS_UUID" ]] && echo "  Redis:       ${PROJECT_NAME}-redis ($REDIS_UUID)"
echo "  S3 storage:  ${S3_PROVIDER}"
echo ""
echo "  ── Domains ─────────────────────────────"
echo ""
echo "  Frontend:  https://${APP_DOMAIN}"
echo "  API:       https://${API_DOMAIN}"
echo "  API (alt): https://${APP_DOMAIN}/api"
echo "  WS:        https://${APP_DOMAIN}/api/ws"
echo "  WS (alt):  https://${API_DOMAIN}/ws"
echo ""
echo "  ── DNS records needed ──────────────────"
echo ""
echo "  Both of these must point to your server:"
echo "    ${APP_DOMAIN}     A/AAAA → server IP"
echo "    ${API_DOMAIN}  A/AAAA → server IP"
echo ""
echo "  In your terraform.tfvars, ensure:"
echo '    subdomains = {'
echo "      \"${APP_DOMAIN%%.*}\"  = \"Frontend + API paths\""
echo "      \"api.${APP_DOMAIN%%.*}\" = \"Dedicated API subdomain\""
echo '    }'
echo ""
echo "  ── GitHub Actions ────────────────────────"
echo ""
echo "  Secrets COOLIFY_WEBHOOK_URL and COOLIFY_TOKEN were pushed to the repo."
echo "  Add this deploy step to your GitHub Actions workflow:"
echo ""
echo '    - name: Trigger Coolify deploy'
echo '      run: |'
echo '        curl -s -f -X GET "${{ secrets.COOLIFY_WEBHOOK_URL }}" \'
echo '          -H "Authorization: Bearer ${{ secrets.COOLIFY_TOKEN }}"'
echo ""
echo "  ── Manual deploy ─────────────────────────"
echo ""
echo "  curl -X GET '${WEBHOOK_URL}' \\"
echo "    -H 'Authorization: Bearer \${COOLIFY_TOKEN}'"
echo ""
echo "  ── What still needs your attention ───────"
echo ""
echo "  1. Verify DNS: dig ${APP_DOMAIN} && dig ${API_DOMAIN}"
echo "  2. First deploy: push to ${GITHUB_REPO_URL} (main branch)"
echo "  3. TLS: auto-issued by Traefik/Let's Encrypt once DNS resolves"
echo "  4. Private repos: configure a GitHub App in Coolify (Sources page)"
[[ -n "$MONGO_UUID" ]] && echo "  5. MongoDB auth: set credentials on the DB resource in Coolify dashboard"
[[ -n "$REDIS_UUID" ]] && echo "  6. Redis password: set on the Redis resource in Coolify dashboard"
echo ""
