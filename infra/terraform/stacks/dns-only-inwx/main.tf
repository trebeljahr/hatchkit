# main.tf — DNS-only stack, INWX variant.
#
# Creates A/AAAA records in INWX's nameservers for an existing Coolify
# server. No new server is created — just DNS records pointing at the
# existing IP.
#
# This is the INWX-only sibling of dns-only-cloudflare/. The two stacks
# were split because the INWX Terraform provider eagerly calls
# account.login during Configure() — even when no resource references it
# — which made a single dual-provider stack fail to plan whenever the
# user only had Cloudflare creds. Each stack now declares only the one
# provider it needs.
#
# HOW TO RUN:
#   cd terraform/stacks/dns-only-inwx
#   export TF_VAR_inwx_username="..."
#   export TF_VAR_inwx_password="..."
#   terraform init
#   terraform plan -var-file=myapp.tfvars
#   terraform apply -var-file=myapp.tfvars

provider "inwx" {
  username = var.inwx_username
  password = var.inwx_password
}

module "dns" {
  source = "../../modules/inwx-dns"

  domain     = var.domain
  subdomains = var.subdomains
  ipv4       = var.target_ipv4
  ipv6       = var.target_ipv6
  ttl        = var.dns_ttl
}
