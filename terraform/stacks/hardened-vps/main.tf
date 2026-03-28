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

resource "hcloud_ssh_key" "deploy" {
  name       = var.ssh_key_name
  public_key = var.ssh_public_key
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

  # Outbound — allow all. Restricting outbound at the Hetzner level is
  # too coarse (breaks apt, Tailscale, Docker pulls). Use UFW for
  # fine-grained outbound control if needed.
  rule {
    description = "All TCP outbound"
    direction   = "out"
    protocol    = "tcp"
    port        = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "All UDP outbound"
    direction   = "out"
    protocol    = "udp"
    port        = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "ICMP outbound"
    direction   = "out"
    protocol    = "icmp"
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

  # Hardened cloud-init: packages, sysctl, fail2ban, UFW, swap.
  # Full hardening is completed by Ansible after this first boot.
  user_data = file("${path.module}/../../../cloud-init/ubuntu-24.04-hardened.yaml")

  firewall_ids = var.firewall_enabled ? [one(hcloud_firewall.hardened[*].id)] : []

  labels = {
    role = "hardened-vps"
    env  = "production"
    app  = var.server_name
  }
}
