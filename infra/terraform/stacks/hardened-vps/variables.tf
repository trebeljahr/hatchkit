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
  description = "Hetzner server type. cpx21 = 3 vCPU / 4 GB, cpx31 = 4 vCPU / 8 GB."
  type        = string
  default     = "cpx21"
}

variable "server_location" {
  description = "Hetzner datacenter: nbg1 = Nuremberg, fsn1 = Falkenstein, hel1 = Helsinki."
  type        = string
  default     = "nbg1"
}

variable "ssh_public_key" {
  description = "Your SSH public key content (from ~/.ssh/id_ed25519.pub)."
  type        = string
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
