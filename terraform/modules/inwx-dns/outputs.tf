output "fqdns" {
  description = "Map of subdomain names to their fully qualified domain names."
  value = {
    for name, _ in var.subdomains : name => "${name}.${var.domain}"
  }
}
