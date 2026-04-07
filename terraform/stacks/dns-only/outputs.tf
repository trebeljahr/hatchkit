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
