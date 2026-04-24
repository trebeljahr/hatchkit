output "dns_records" {
  description = "DNS records created."
  value = {
    for name, desc in var.subdomains : name => {
      fqdn = "${name}.${var.domain}"
      ipv4 = var.target_ipv4
      ipv6 = var.target_ipv6
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
