# outputs.tf — Values Terraform prints after `terraform apply`.
#
# HOW OUTPUTS WORK:
# After apply, Terraform shows these values. They're also queryable later
# with `terraform output` or `terraform output -json` (useful in scripts).
#
# If an output is `sensitive = true`, it's hidden from CLI output but still
# stored in the state file. You can reveal it with `terraform output -raw <name>`.

output "server_ipv4" {
  description = "Public IPv4 address of the server."
  value       = hcloud_server.main.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the server."
  value       = hcloud_server.main.ipv6_address
}

output "server_id" {
  description = "Hetzner Cloud server ID (useful for hcloud CLI commands)."
  value       = hcloud_server.main.id
}

output "dns_records" {
  description = "DNS records that were created."
  value = {
    for name, desc in var.subdomains : name => {
      fqdn = "${name}.${var.domain}"
      ipv4 = hcloud_server.main.ipv4_address
      ipv6 = hcloud_server.main.ipv6_address
    }
  }
  # This outputs a nice map like:
  # {
  #   "app" = { fqdn = "app.example.com", ipv4 = "1.2.3.4", ipv6 = "..." }
  # }
}

# Unified outputs consumed by devops-cli after `terraform apply`:
# the CLI reads these with `terraform output -json` to know which domain
# was touched and, if Cloudflare, which nameservers to point INWX at.

output "dns_provider" {
  description = "Which DNS provider this stack was applied with."
  value       = var.dns_provider
}

output "dns_domain" {
  description = "Base domain this stack manages."
  value       = var.domain
}

output "dns_nameservers" {
  description = "Cloudflare nameservers for the zone (empty when dns_provider is not 'cloudflare')."
  value = var.dns_provider == "cloudflare" && length(module.dns_cloudflare) > 0 ? (
    module.dns_cloudflare[0].name_servers
  ) : []
}

output "ssh_command" {
  description = "SSH command to connect to the server."
  value       = "ssh root@${hcloud_server.main.ipv4_address}"
}

# ---------------------------------------------------------------------------
# S3 outputs
# ---------------------------------------------------------------------------

output "s3_bucket" {
  description = "S3 bucket name (empty if s3_enabled = false)."
  value       = var.s3_enabled ? minio_s3_bucket.assets[0].bucket : ""
}

output "s3_endpoint" {
  description = "S3 endpoint URL for the app to connect to."
  value       = var.s3_enabled ? "https://${var.s3_location}.your-objectstorage.com" : ""
}

output "s3_region" {
  description = "S3 region (same as the Hetzner location)."
  value       = var.s3_enabled ? var.s3_location : ""
}

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

output "next_steps" {
  description = "What to do after terraform apply."
  value       = <<-EOT
    Server is provisioning. Next steps:

    Phase 1 — Bootstrap + harden:
    1. Wait ~2 min for cloud-init to finish
       Check: ssh root@${hcloud_server.main.ipv4_address} 'test -f /var/lib/cloud/instance/hardening-init-done && echo READY'
    2. Add server to Ansible inventory (ansible/inventories/production/hosts.ini)
    3. Run: make harden  (full security hardening via Ansible)
    4. Install Coolify: ./scripts/install-coolify.sh
    5. Configure Coolify app + DBs: hatchkit create  (interactive, drives the Coolify API)

    Phase 2 — Lockdown (after Coolify has domain + HTTPS):
    6. Set coolify_bootstrapped = true in terraform.tfvars
    7. Run: terraform apply  (removes port 8000 from Hetzner firewall)
    8. Run: make lockdown     (removes port 8000 from UFW)

    See docs/hardening-guide.md for manual steps and deep explanations.
  EOT
}
