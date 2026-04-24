# outputs.tf — Values printed after `terraform apply`.

output "server_ipv4" {
  description = "Public IPv4 address of the API server."
  value       = hcloud_server.main.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the API server."
  value       = hcloud_server.main.ipv6_address
}

output "server_id" {
  description = "Hetzner Cloud server ID."
  value       = hcloud_server.main.id
}

output "dns_records" {
  description = "DNS records created for the API server."
  value = {
    for name, desc in var.subdomains : name => {
      fqdn = "${name}.${var.domain}"
      ipv4 = hcloud_server.main.ipv4_address
      ipv6 = hcloud_server.main.ipv6_address
    }
  }
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

output "s3_uploads_bucket" {
  description = "S3 bucket name for user-uploaded photos."
  value       = var.s3_enabled ? minio_s3_bucket.uploads[0].bucket : ""
}

output "s3_models_bucket" {
  description = "S3 bucket name for generated 3D models (GLB files)."
  value       = var.s3_enabled ? minio_s3_bucket.models[0].bucket : ""
}

output "s3_endpoint" {
  description = "S3 endpoint URL."
  value       = var.s3_enabled ? "https://${var.s3_location}.your-objectstorage.com" : ""
}

output "s3_region" {
  description = "S3 region."
  value       = var.s3_enabled ? var.s3_location : ""
}

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

output "next_steps" {
  description = "What to do after terraform apply."
  value       = <<-EOT
    API server is provisioning. Next steps:

    Phase 1 — Bootstrap + harden:
    1. Wait ~2 min for cloud-init to finish
       Check: ssh root@${hcloud_server.main.ipv4_address} 'test -f /var/lib/cloud/instance/hardening-init-done && echo READY'
    2. Add server to Ansible inventory (ansible/inventories/production/hosts.ini)
    3. Run: make harden
    4. Install Coolify: ./scripts/install-coolify.sh
    5. Configure Coolify: make coolify-setup STACK=gpu-inference

    Phase 2 — Lockdown:
    6. Set coolify_bootstrapped = true in terraform.tfvars
    7. Run: terraform apply
    8. Run: make lockdown

    Phase 3 — GPU platform:
    9. Set up Modal / RunPod / AWS Batch (see templates/apps/gpu-inference-api/)
    10. Configure GPU_PROVIDER and GPU_API_URL in your stack .env
    11. Deploy the inference container to your chosen GPU platform

    See docs/gpu-inference-pipeline.md for platform comparison and cost analysis.
  EOT
}
