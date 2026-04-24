# main.tf — Node realtime stack: Hetzner server + INWX DNS + S3 bucket.
#
# WHAT THIS FILE DOES:
# 1. Configures providers (Hetzner, INWX, MinIO/S3) with your credentials
# 2. Creates an SSH key in Hetzner Cloud
# 3. Creates a firewall (optional but recommended)
# 4. Creates the server with cloud-init for first-boot setup
# 5. Creates DNS A/AAAA records for each subdomain
# 6. Creates an S3 bucket on Hetzner Object Storage (optional)
#
# HOW TO RUN:
#   cd terraform/stacks/node-realtime
#   export TF_VAR_hcloud_token="your-hetzner-token"
#   export TF_VAR_inwx_username="your-inwx-user"
#   export TF_VAR_inwx_password="your-inwx-pass"
#   export TF_VAR_s3_access_key="your-hetzner-s3-access-key"
#   export TF_VAR_s3_secret_key="your-hetzner-s3-secret-key"
#   terraform init        # downloads providers, creates lock file
#   terraform plan        # dry run — shows what WOULD happen
#   terraform apply       # actually creates resources
#
# IMPORTANT: `terraform plan` is your best friend. ALWAYS run it before apply.
# Read the output carefully — it shows creates (+), changes (~), and
# destroys (-). Never blindly apply.

# ---------------------------------------------------------------------------
# Provider configuration
# ---------------------------------------------------------------------------

# Each provider block tells Terraform how to authenticate with a service.
# Think of it like a database connection config.

provider "hcloud" {
  token = var.hcloud_token
  # This token has FULL access to your Hetzner project.
  # Create a dedicated project for each environment (staging, prod)
  # so a leaked token can't nuke everything.
}

provider "inwx" {
  username = var.inwx_username
  password = var.inwx_password
  # GOTCHA: INWX has a sandbox environment for testing. If you want to test
  # without touching real DNS, set `sandbox = true` here. But remember to
  # remove it before going to production — I've seen people debug for hours
  # because records were going to sandbox.
}

# Cloudflare is declared unconditionally alongside INWX so the stack can
# switch between them via var.dns_provider. Terraform only initializes a
# provider when a resource references it, so leaving api_token = "" is
# harmless when dns_provider = "inwx".
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# The MinIO provider speaks the S3 protocol. We point it at Hetzner's
# S3-compatible endpoint. Despite the provider name, this has nothing to do
# with running MinIO yourself — it's just an S3 client that can create buckets.
provider "minio" {
  minio_server   = "${var.s3_location}.your-objectstorage.com"
  minio_user     = var.s3_access_key
  minio_password = var.s3_secret_key
  minio_region   = var.s3_location
  minio_ssl      = true
  # minio_ssl = true means it connects over HTTPS (port 443).
  # Hetzner Object Storage only accepts HTTPS, so this must be true.
}

# ---------------------------------------------------------------------------
# SSH key
# ---------------------------------------------------------------------------

# Upload your SSH public key to Hetzner so it gets injected into new servers.
# This is the same key you use for `ssh root@your-server`.

resource "hcloud_ssh_key" "deploy" {
  name       = var.ssh_key_name
  public_key = var.ssh_public_key
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

# A Hetzner Cloud Firewall is like a security group — it filters traffic
# BEFORE it reaches your server. This is defense in depth: even if your
# server's iptables are misconfigured, the firewall still blocks bad ports.

resource "hcloud_firewall" "web" {
  count = var.firewall_enabled ? 1 : 0
  # `count` is a Terraform meta-argument. When 0, the resource isn't created.
  # This is the standard pattern for optional resources.

  name = "${var.server_name}-fw"

  # SSH — needed for Ansible bootstrap and emergency access.
  # Once Tailscale is set up, you could remove this and SSH over the tailnet.
  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
    # Opening SSH to the world is fine IF you enforce key-only auth
    # (which the Ansible ssh_hardening role does). For extra lockdown,
    # replace these with your specific IP ranges.
  }

  # HTTP/HTTPS — Coolify's Traefik reverse proxy needs these.
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

  # Coolify bootstrap port — needed only during initial setup.
  # After Coolify has a domain + HTTPS, set coolify_bootstrapped = true
  # and re-apply to remove this rule. Also run playbooks/lockdown-coolify.yml
  # to close the port in UFW.
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

  # Outbound — allow all (restricting at Hetzner level breaks apt, Tailscale, Docker)
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

# This creates the actual VPS. The cloud-init file runs on first boot
# to install packages, configure fail2ban, set up swap, etc.

resource "hcloud_server" "main" {
  name        = var.server_name
  image       = "ubuntu-24.04"
  server_type = var.server_type
  location    = var.server_location
  ssh_keys    = [hcloud_ssh_key.deploy.id]

  # cloud-init: this YAML runs once on first boot. It's the same file
  # your existing create-hetzner-server.sh passes to `hcloud server create`.
  #
  # `file()` reads a local file at plan time. The path is relative to
  # the directory where you run `terraform plan`.
  user_data = file("${path.module}/../../../cloud-init/ubuntu-24.04-hardened.yaml")
  # path.module = directory of THIS .tf file (terraform/stacks/node-realtime/)
  # We go up 3 levels to reach the repo root, then into cloud-init/.

  # Attach the firewall if enabled.
  # `one()` extracts the single element from a list, or null if empty.
  # We need this because count-created resources are always lists.
  firewall_ids = var.firewall_enabled ? [one(hcloud_firewall.web[*].id)] : []

  labels = {
    role = "coolify"
    env  = "production"
    app  = var.server_name
  }

  # IMPORTANT: public_net is enabled by default, giving you both IPv4 and IPv6.
  # If you only want IPv6 (cheaper, no IPv4 fee), you'd set:
  #   public_net { ipv4_enabled = false; ipv6_enabled = true }
  # But many services still need IPv4, so we keep both.
}

# ---------------------------------------------------------------------------
# DNS records
# ---------------------------------------------------------------------------
#
# We dispatch DNS to one of two modules based on var.dns_provider. The
# unused module is gated to count=0 and never runs. This keeps the stack
# file small and lets us share the DNS logic with other stacks through
# modules/inwx-dns/ and modules/cloudflare-dns/.
#
# Both modules use `for_each` internally on the subdomains map — the same
# safety property as before (adding/removing one subdomain doesn't churn
# the others).

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
# S3 bucket (Hetzner Object Storage)
# ---------------------------------------------------------------------------

# Creates a bucket on Hetzner Object Storage for app assets (uploads,
# images, etc.). The bucket is created via the S3 API using the MinIO
# provider — no Hetzner-specific API needed for this part.
#
# WHAT YOU GET:
# - A bucket at https://<s3_location>.your-objectstorage.com/<bucket-name>
# - Accessible with the same S3 credentials you passed to Terraform
# - Your app uses these credentials + endpoint + bucket name to read/write
#
# LIFECYCLE NOTE:
# `terraform destroy` will try to delete the bucket. If it contains objects,
# the delete will fail (S3 won't delete non-empty buckets). You'd need to
# empty it first. This is a safety feature — you won't accidentally lose
# uploads by running destroy.

resource "minio_s3_bucket" "assets" {
  count = var.s3_enabled ? 1 : 0

  bucket = var.s3_bucket_name
  acl    = var.s3_bucket_acl

  # GOTCHA: Bucket names are globally unique across all Hetzner Object
  # Storage users. If your name is taken, you'll get an error.
  # Use a specific name like "myapp-assets-prod" or add a random suffix.
}

# ---------------------------------------------------------------------------
# S3 CORS configuration
# ---------------------------------------------------------------------------

# If your app does direct browser uploads to S3 (e.g. drag-and-drop file
# upload that goes straight to the bucket), the browser needs CORS headers
# from the S3 endpoint. Without this, the browser blocks the upload.
#
# This allows your app domain to make PUT/POST requests directly to the bucket.
# If your app proxies uploads through the backend instead, this isn't strictly
# needed — but it doesn't hurt to have it.

resource "minio_s3_bucket_cors_configuration" "assets" {
  count = var.s3_enabled ? 1 : 0

  bucket = minio_s3_bucket.assets[0].bucket

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://*"]
    # In production, tighten this to your actual domain:
    # allowed_origins = ["https://myapp.example.com"]
    max_age_seconds = 3600
  }
}
