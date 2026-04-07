# main.tf — DNS-only stack. Creates A/AAAA records for an existing server.
#
# Use this when deploying a new app to an existing Coolify server.
# No new server is created — just DNS records pointing at the existing IP.
#
# HOW TO RUN:
#   cd terraform/stacks/dns-only
#   export TF_VAR_inwx_username="..."
#   export TF_VAR_inwx_password="..."
#   terraform init
#   terraform plan -var-file=myapp.tfvars
#   terraform apply -var-file=myapp.tfvars

provider "inwx" {
  username = var.inwx_username
  password = var.inwx_password
}

resource "inwx_nameserver_record" "a" {
  for_each = var.subdomains

  domain  = var.domain
  name    = "${each.key}.${var.domain}"
  type    = "A"
  content = var.target_ipv4
  ttl     = var.dns_ttl
}

resource "inwx_nameserver_record" "aaaa" {
  for_each = var.target_ipv6 != "" ? var.subdomains : {}

  domain  = var.domain
  name    = "${each.key}.${var.domain}"
  type    = "AAAA"
  content = var.target_ipv6
  ttl     = var.dns_ttl
}
