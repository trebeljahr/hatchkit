# variables.tf — All inputs for the gpu-inference stack.
#
# This stack provisions a Hetzner VPS for the web API + job dispatcher,
# DNS records, and two S3 buckets (one for user uploads, one for generated
# 3D models). The actual GPU inference runs on an external platform
# (Modal, RunPod, or AWS Batch) — configured in the app env, not here.
#
# The Hetzner server does NOT need a GPU. It runs Coolify with a FastAPI
# container that receives photo uploads, dispatches GPU jobs, and serves
# the resulting GLB files via presigned URLs.

# ---------------------------------------------------------------------------
# Hetzner Cloud
# ---------------------------------------------------------------------------

variable "hcloud_token" {
  description = "Hetzner Cloud API token. Best set via TF_VAR_hcloud_token env var."
  type        = string
  sensitive   = true
}

variable "server_name" {
  description = "Name for the Hetzner server (e.g. 'photo3d-prod')."
  type        = string
  default     = "gpu-inference-api"
}

variable "server_type" {
  description = <<-EOT
    Hetzner server type for the API server. This does NOT need a GPU —
    it's just the web API that dispatches jobs to an external GPU platform.
    cpx21 = 3 vCPU / 4 GB (fine for low traffic)
    cpx31 = 4 vCPU / 8 GB (if you need more headroom for concurrent uploads)
  EOT
  type        = string
  default     = "cpx21"
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
    Map of subdomain names to their purpose. Each gets A + AAAA records.

    Example for a photo-to-3D service:
      subdomains = {
        "3d"        = "Web app + upload UI"
        "api.3d"    = "REST API for model generation"
        "admin"     = "Coolify dashboard"
      }
  EOT
  type        = map(string)
  default = {
    "3d"        = "Web app + upload UI"
    "api.3d"    = "REST API"
  }
}

variable "dns_ttl" {
  description = "TTL for DNS records in seconds. 300 during setup, 3600 for production."
  type        = number
  default     = 3600
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
    This removes the bootstrap port (8000) from the firewall.
  EOT
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# S3: Uploads bucket (user-uploaded photos)
# ---------------------------------------------------------------------------

variable "s3_enabled" {
  description = "Whether to create S3 buckets on Hetzner Object Storage."
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
  description = "Hetzner Object Storage location. Use the same location as the server."
  type        = string
  default     = "nbg1"
}

variable "s3_uploads_bucket_name" {
  description = <<-EOT
    Bucket for user-uploaded photos. Private, presigned URL access only.
    Photos are uploaded here, then sent to the GPU pipeline for processing.
    Consider adding a lifecycle policy to delete uploads after N days.
  EOT
  type        = string
  default     = "photo3d-uploads"
}

variable "s3_models_bucket_name" {
  description = <<-EOT
    Bucket for generated 3D models (GLB files). Private, served via
    presigned URLs or CDN. These are the output of the GPU pipeline —
    the Shopify viewer loads them from here.

    NOTE: Consider putting Cloudflare in front for CDN + zero egress fees.
    GLB files are 1-20 MB each and egress costs add up on raw S3.
  EOT
  type        = string
  default     = "photo3d-models"
}
