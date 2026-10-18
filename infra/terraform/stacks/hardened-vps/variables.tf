# variables.tf — Inputs for the hardened VPS stack.
#
# This stack creates a general-purpose hardened Hetzner server with:
# - Hetzner Cloud Firewall (22, 80, 443 only)
# - Hardened cloud-init for first-boot security
# - SSH key injection
#
# No DNS or S3 — this is a minimal, secure server.
# For a full Coolify stack with DNS + S3, use terraform/stacks/node-realtime/.

# ---------------------------------------------------------------------------
# Hetzner Cloud
# ---------------------------------------------------------------------------

variable "hcloud_token" {
  description = "Hetzner Cloud API token. Best set via TF_VAR_hcloud_token env var."
  type        = string
  sensitive   = true
}

variable "server_name" {
  description = "Name for the Hetzner server (e.g. 'hardened-vps')."
  type        = string
  default     = "hardened-vps"
}

variable "server_type" {
  description = "Hetzner server type. e.g. cx23 = 2 vCPU / 4 GB, cx33 = 4 vCPU / 8 GB (shared x86)."
  type        = string
  default     = "cpx21"
}

variable "server_location" {
  description = "Hetzner datacenter: nbg1 = Nuremberg, fsn1 = Falkenstein, hel1 = Helsinki."
  type        = string
  default     = "nbg1"
}

variable "ssh_public_key" {
  description = "Your SSH public key content (from ~/.ssh/id_ed25519.pub). Unused when existing_ssh_key_name is set."
  type        = string
  default     = ""
}

variable "existing_ssh_key_name" {
  description = "Name of an SSH key already in the Hetzner project. When set, the stack uses it instead of uploading ssh_public_key."
  type        = string
  default     = ""
}

variable "ssh_key_name" {
  description = "Label for the SSH key in Hetzner Cloud."
  type        = string
  default     = "deploy-key"
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

variable "firewall_enabled" {
  description = "Whether to create a Hetzner Cloud firewall. Recommended: true."
  type        = bool
  default     = true
}

variable "ssh_source_ips" {
  description = "Source CIDRs allowed to reach public SSH (22). [] closes public SSH at the provider firewall."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "http_source_ips" {
  description = "Source CIDRs allowed on 80/443. Set to Cloudflare's ranges (https://www.cloudflare.com/ips/) when every hostname is proxied, so scanners cannot reach the origin directly. Let's Encrypt HTTP-01 still works through the proxy."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "tailscale_direct_udp" {
  description = "Open UDP 41641 so Tailscale peers can connect directly."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Server options
# ---------------------------------------------------------------------------

variable "backups" {
  description = "Enable Hetzner's daily server backups (+20% of the server price)."
  type        = bool
  default     = false
}

variable "server_role" {
  description = "Value of the server's `role` label."
  type        = string
  default     = "hardened-vps"
}
