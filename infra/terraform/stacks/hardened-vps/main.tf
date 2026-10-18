# main.tf — Hardened VPS: Hetzner server with security-first configuration.
#
# WHAT THIS FILE DOES:
# 1. Configures the Hetzner Cloud provider
# 2. Creates an SSH key in Hetzner Cloud
# 3. Creates a firewall allowing only SSH (22), HTTP (80), HTTPS (443)
# 4. Creates the server with hardened cloud-init for first-boot security
#
# HOW TO RUN:
#   cd terraform/stacks/hardened-vps
#   export TF_VAR_hcloud_token="your-hetzner-token"
#   terraform init
#   terraform plan        # ALWAYS review before applying
#   terraform apply
#
# AFTER APPLY:
#   1. Wait ~2 min for cloud-init to finish
#   2. Run: make harden HOST=<server-ip>
#   3. Optionally: make lockdown  (if Coolify was installed)

# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

provider "hcloud" {
  token = var.hcloud_token
}

# ---------------------------------------------------------------------------
# SSH key
# ---------------------------------------------------------------------------

# Hetzner refuses a second key with the same fingerprint, so a project that
# already holds your key names it in existing_ssh_key_name instead.
resource "hcloud_ssh_key" "deploy" {
  count      = var.existing_ssh_key_name == "" ? 1 : 0
  name       = var.ssh_key_name
  public_key = var.ssh_public_key
}

data "hcloud_ssh_key" "existing" {
  count = var.existing_ssh_key_name == "" ? 0 : 1
  name  = var.existing_ssh_key_name
}

locals {
  ssh_key_id = var.existing_ssh_key_name == "" ? hcloud_ssh_key.deploy[0].id : data.hcloud_ssh_key.existing[0].id
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

# Hetzner Cloud Firewall filters at the hypervisor level — traffic is dropped
# before it reaches your VM. This is your first line of defense.
# See docs/hardening-guide.md section 1.3 for details.

resource "hcloud_firewall" "hardened" {
  count = var.firewall_enabled ? 1 : 0
  name  = "${var.server_name}-fw"

  # SSH — needed for Ansible and emergency access.
  # After Tailscale is configured, this can be restricted further via UFW
  # (the Hetzner firewall allows it, UFW restricts to tailnet only).
  # Narrow ssh_source_ips to your own address for the first Ansible run, and
  # set it to [] once Tailscale SSH works to close public 22 entirely.
  dynamic "rule" {
    for_each = length(var.ssh_source_ips) > 0 ? [1] : []
    content {
      description = "SSH"
      direction   = "in"
      protocol    = "tcp"
      port        = "22"
      source_ips  = var.ssh_source_ips
    }
  }

  # Lets Tailscale peers connect directly instead of through a DERP relay.
  dynamic "rule" {
    for_each = var.tailscale_direct_udp ? [1] : []
    content {
      description = "Tailscale direct"
      direction   = "in"
      protocol    = "udp"
      port        = "41641"
      source_ips  = ["0.0.0.0/0", "::/0"]
    }
  }

  rule {
    description = "HTTP"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = var.http_source_ips
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = var.http_source_ips
  }

  # Outbound — allow all. Restricting outbound at the Hetzner level is
  # too coarse (breaks apt, Tailscale, Docker pulls). Use UFW for
  # fine-grained outbound control if needed.
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
  ssh_keys    = [local.ssh_key_id]
  backups     = var.backups

  # Hardened cloud-init: packages, sysctl, fail2ban, UFW, swap.
  # Full hardening is completed by Ansible after this first boot.
  user_data = file("${path.module}/../../../cloud-init/ubuntu-24.04-hardened.yaml")

  firewall_ids = var.firewall_enabled ? [one(hcloud_firewall.hardened[*].id)] : []

  # user_data and the SSH key only matter at first boot. The cloud-init file
  # is shared by every stack, so without this an edit to it (or a new key)
  # would destroy and rebuild every live server on the next apply.
  lifecycle {
    ignore_changes = [user_data, ssh_keys, image]
  }

  labels = {
    role = var.server_role
    env  = "production"
    app  = var.server_name
  }
}
