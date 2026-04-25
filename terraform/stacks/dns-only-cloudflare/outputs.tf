# Outputs consumed by the hatchkit CLI after `terraform apply`. The CLI
# reads these with `terraform output -json` to know which domain was
# touched and which Cloudflare nameservers to point the registrar at.

output "dns_provider" {
  description = "Which DNS provider this stack was applied with."
  value       = "cloudflare"
}

output "dns_domain" {
  description = "Base domain this stack manages."
  value       = var.domain
}

output "dns_nameservers" {
  description = "Cloudflare nameservers for the zone."
  value       = module.dns.name_servers
}

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
