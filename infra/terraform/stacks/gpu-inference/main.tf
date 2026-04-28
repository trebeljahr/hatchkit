# main.tf — GPU inference stack: Hetzner API server + DNS + dual S3 buckets.
#
# ARCHITECTURE:
# This stack provisions the "orchestration layer" — the web API server that
# receives photo uploads, dispatches GPU inference jobs, and serves results.
# The GPU inference itself runs on an external platform (Modal, RunPod, or
# AWS Batch), NOT on this server.
#
#   User → Hetzner VPS (FastAPI) → Modal/RunPod (GPU) → S3 (GLB output)
#                                                              ↓
#                                              Shopify storefront (R3F viewer)
#
# Two S3 buckets:
#   1. Uploads bucket: receives user photos (private, presigned URL upload)
#   2. Models bucket: stores generated GLB files (private, CDN-fronted)
#
# HOW TO RUN:
#   cd terraform/stacks/gpu-inference
#   export TF_VAR_hcloud_token="..."
#   export TF_VAR_inwx_username="..."
#   export TF_VAR_inwx_password="..."
#   export TF_VAR_s3_access_key="..."
#   export TF_VAR_s3_secret_key="..."
#   terraform init
#   terraform plan
#   terraform apply

# ---------------------------------------------------------------------------
# Provider configuration
# ---------------------------------------------------------------------------

provider "hcloud" {
  token = var.hcloud_token
}

provider "inwx" {
  username = var.inwx_username
  password = var.inwx_password
}

# Cloudflare is declared alongside INWX so this stack can swap DNS providers
# via var.dns_provider. Terraform only initializes a provider when a resource
# references it, so the unused one sits idle with empty credentials.
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "minio" {
  minio_server   = "${var.s3_location}.your-objectstorage.com"
  minio_user     = var.s3_access_key
  minio_password = var.s3_secret_key
  minio_region   = var.s3_location
  minio_ssl      = true
}

# ---------------------------------------------------------------------------
# SSH key
# ---------------------------------------------------------------------------

resource "hcloud_ssh_key" "deploy" {
  name       = var.ssh_key_name
  public_key = var.ssh_public_key
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

resource "hcloud_firewall" "web" {
  count = var.firewall_enabled ? 1 : 0
  name  = "${var.server_name}-fw"

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTP"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  dynamic "rule" {
    for_each = var.coolify_bootstrapped ? [] : [1]
    content {
      description = "Coolify dashboard (bootstrap only — remove after setup)"
      direction   = "in"
      protocol    = "tcp"
      port        = "8000"
      source_ips  = ["0.0.0.0/0", "::/0"]
    }
  }

  rule {
    description     = "All TCP outbound"
    direction       = "out"
    protocol        = "tcp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description     = "All UDP outbound"
    direction       = "out"
    protocol        = "udp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description     = "ICMP outbound"
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }
}

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

resource "hcloud_server" "main" {
  name        = var.server_name
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.server_location
  ssh_keys    = [hcloud_ssh_key.deploy.id]

  user_data = file("${path.module}/../../../cloud-init/ubuntu-24.04-hardened.yaml")

  firewall_ids = var.firewall_enabled ? [one(hcloud_firewall.web[*].id)] : []

  labels = {
    role = "coolify"
    env  = "production"
    app  = var.server_name
  }
}

# ---------------------------------------------------------------------------
# DNS records — dispatched to one of two modules based on var.dns_provider.
# ---------------------------------------------------------------------------

module "dns_inwx" {
  count  = var.dns_provider == "inwx" ? 1 : 0
  source = "../../modules/inwx-dns"

  domain     = var.domain
  subdomains = var.subdomains
  ipv4       = hcloud_server.main.ipv4_address
  ipv6       = hcloud_server.main.ipv6_address
  ttl        = var.dns_ttl
}

module "dns_cloudflare" {
  count  = var.dns_provider == "cloudflare" ? 1 : 0
  source = "../../modules/cloudflare-dns"

  domain     = var.domain
  subdomains = var.subdomains
  ipv4       = hcloud_server.main.ipv4_address
  ipv6       = hcloud_server.main.ipv6_address
  ttl        = var.dns_ttl
  proxied    = var.cloudflare_proxied
}

# ---------------------------------------------------------------------------
# S3 bucket: uploads (user-submitted photos)
# ---------------------------------------------------------------------------

resource "minio_s3_bucket" "uploads" {
  count  = var.s3_enabled ? 1 : 0
  bucket = var.s3_uploads_bucket_name
  acl    = "private"
}

resource "minio_s3_bucket_cors_configuration" "uploads" {
  count  = var.s3_enabled ? 1 : 0
  bucket = minio_s3_bucket.uploads[0].bucket

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://*"]
    # Tighten to your domain in production:
    # allowed_origins = ["https://3d.example.com"]
    max_age_seconds = 3600
  }
}

# ---------------------------------------------------------------------------
# S3 bucket: models (generated GLB files)
# ---------------------------------------------------------------------------

resource "minio_s3_bucket" "models" {
  count  = var.s3_enabled ? 1 : 0
  bucket = var.s3_models_bucket_name
  acl    = "private"
  # GLB files are served via presigned URLs or through a CDN (Cloudflare).
  # Never public-read — you want to track access and enforce rate limits.
}

resource "minio_s3_bucket_cors_configuration" "models" {
  count  = var.s3_enabled ? 1 : 0
  bucket = minio_s3_bucket.models[0].bucket

  cors_rule {
    allowed_headers = ["*"]
    # GET only — models bucket is read-only from the browser.
    # The GPU pipeline writes to it server-side.
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["https://*"]
    max_age_seconds = 3600
  }
}
