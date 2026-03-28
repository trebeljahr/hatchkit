# variables.tf — All inputs for the node-realtime stack.
#
# HOW VARIABLES WORK:
# Each `variable` block declares a named input. You provide values in a
# terraform.tfvars file (or via -var flags). If a variable has a `default`,
# it's optional. If it doesn't, Terraform will prompt you or error out.
#
# GOTCHA: Never put secrets directly in .tf files or commit .tfvars files
# with real credentials. Use environment variables (TF_VAR_xxx) or a
# secrets manager for production. We'll use TF_VAR_ for provider creds
# and .tfvars only for non-secret config.

# ---------------------------------------------------------------------------
# Hetzner Cloud
# ---------------------------------------------------------------------------

variable "hcloud_token" {
  description = "Hetzner Cloud API token. Best set via TF_VAR_hcloud_token env var."
  type        = string
  sensitive   = true
  # `sensitive = true` means Terraform will redact this value from CLI output
  # and plan files. It does NOT encrypt it in state — more on that below.
}

variable "server_name" {
  description = "Name for the Hetzner server (e.g. 'myapp-prod')."
  type        = string
  default     = "coolify-vps"
}

variable "server_type" {
  description = "Hetzner server type. cpx21 = 3 vCPU / 4 GB, cpx31 = 4 vCPU / 8 GB."
  type        = string
  default     = "cpx21"
  # cpx = AMD EPYC shared vCPU. Good price/performance for small SaaS.
  # See https://www.hetzner.com/cloud for current types and pricing.
}

variable "server_location" {
  description = "Hetzner datacenter location. nbg1 = Nuremberg, fsn1 = Falkenstein, hel1 = Helsinki."
  type        = string
  default     = "nbg1"
}

variable "ssh_public_key" {
  description = "Your SSH public key content (the string from ~/.ssh/id_ed25519.pub)."
  type        = string
}

variable "ssh_key_name" {
  description = "Label for the SSH key in Hetzner Cloud."
  type        = string
  default     = "deploy-key"
}

# ---------------------------------------------------------------------------
# INWX DNS
# ---------------------------------------------------------------------------

variable "inwx_username" {
  description = "INWX account username. Best set via TF_VAR_inwx_username env var."
  type        = string
  sensitive   = true
}

variable "inwx_password" {
  description = "INWX account password. Best set via TF_VAR_inwx_password env var."
  type        = string
  sensitive   = true
}

variable "domain" {
  description = "Base domain managed in INWX (e.g. 'example.com')."
  type        = string
}

variable "subdomains" {
  description = <<-EOT
    Map of subdomain names to their purpose. Each gets an A record (and AAAA
    if server has IPv6) pointing to the Hetzner server.

    Example for myapp.example.com with API subdomain:
      subdomains = {
        "myapp"     = "Frontend + API paths"
        "api.myapp" = "Dedicated API subdomain"
        "admin"     = "Coolify dashboard"
      }

    This creates myapp.example.com, api.myapp.example.com, admin.example.com
    all pointing to your server IP.

    IMPORTANT: The setup-coolify-stack.sh script auto-derives api.<app-domain>
    from the APP_DOMAIN in your stack .env file. Make sure both the base
    subdomain AND the api.* subdomain are listed here, or DNS won't resolve
    and TLS cert issuance will fail.
  EOT
  type        = map(string)
  default = {
    "app"     = "Frontend + API paths"
    "api.app" = "Dedicated API subdomain"
  }
}

variable "dns_ttl" {
  description = "TTL for DNS records in seconds. 3600 = 1 hour. Lower during testing, raise for production."
  type        = number
  default     = 3600
  # GOTCHA: If you set this to 300 (5 min) during setup for fast propagation,
  # remember to raise it to 3600+ for production. Low TTLs cause more DNS
  # lookups and can slow down page loads marginally.
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

variable "firewall_enabled" {
  description = "Whether to create a Hetzner Cloud firewall. Recommended: true."
  type        = bool
  default     = true
}

variable "coolify_bootstrapped" {
  description = <<-EOT
    Set to true AFTER Coolify is configured with a domain and HTTPS.
    This removes the bootstrap port (8000) from the Hetzner Cloud Firewall.

    Two-phase flow:
    1. terraform apply (coolify_bootstrapped = false) — port 8000 open
    2. Install Coolify, configure domain + HTTPS
    3. terraform apply (coolify_bootstrapped = true) — port 8000 closed
    4. ansible-playbook playbooks/lockdown-coolify.yml — port 8000 closed in UFW too
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Hetzner Object Storage (S3)
# ---------------------------------------------------------------------------

# HOW HETZNER OBJECT STORAGE CREDENTIALS WORK:
#
# Unlike the Hetzner Cloud API token (which you generate via API), Object
# Storage S3 credentials must be created in the Hetzner Cloud console:
#   Console → your project → Object Storage → Manage credentials
#
# You get an access_key and secret_key pair — these are standard S3 creds,
# NOT the same as your Hetzner Cloud API token. One credential pair can
# access ALL buckets in your project.
#
# There is no Hetzner API to generate these programmatically (as of 2025).
# So you create them once in the console, then pass them here.

variable "s3_enabled" {
  description = "Whether to create an S3 bucket on Hetzner Object Storage."
  type        = bool
  default     = true
}

variable "s3_access_key" {
  description = "Hetzner Object Storage access key. Best set via TF_VAR_s3_access_key env var."
  type        = string
  sensitive   = true
  default     = ""
}

variable "s3_secret_key" {
  description = "Hetzner Object Storage secret key. Best set via TF_VAR_s3_secret_key env var."
  type        = string
  sensitive   = true
  default     = ""
}

variable "s3_location" {
  description = <<-EOT
    Hetzner Object Storage location. This determines the S3 endpoint URL.
    Must match one of Hetzner's available Object Storage locations:
      fsn1 = Falkenstein
      nbg1 = Nuremberg
      hel1 = Helsinki

    TIP: Use the same location as your server for lowest latency.
    The endpoint becomes: https://<location>.your-objectstorage.com
  EOT
  type        = string
  default     = "nbg1"
}

variable "s3_bucket_name" {
  description = <<-EOT
    Name for the S3 bucket. Must be globally unique across all Hetzner Object
    Storage users (just like AWS S3). Use a prefix like your project name.
    Example: "myapp-assets-prod"

    GOTCHA: Bucket names must be 3-63 characters, lowercase, no underscores.
    Hyphens are fine. Think of it like a subdomain — because internally it
    becomes part of a URL.
  EOT
  type        = string
  default     = "myapp-assets"
}

variable "s3_bucket_acl" {
  description = <<-EOT
    Bucket access control. Options:
      "private"     = only accessible with credentials (default, most secure)
      "public-read" = anyone can read objects if they know the URL

    For app assets served to browsers, you typically want "private" and serve
    through your app (which adds auth) or through a CDN with a signed URL.
    Use "public-read" only for truly public assets (marketing images, etc.).
  EOT
  type        = string
  default     = "private"
}
