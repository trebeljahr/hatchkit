# Outputs consumed by the hatchkit CLI after `terraform apply`.

output "dns_provider" {
  description = "Which DNS provider this stack was applied with."
  value       = "inwx"
}

output "dns_domain" {
  description = "Base domain this stack manages."
  value       = var.domain
}

output "dns_nameservers" {
  description = "Empty for INWX (records live in INWX's own nameservers — no registrar flip needed)."
  value       = []
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
