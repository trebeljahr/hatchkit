# main.tf — DNS-only stack, Cloudflare variant.
#
# Creates A/AAAA records in an existing Cloudflare zone for an existing
# Coolify server. No new server is created — just DNS records pointing at
# the existing IP.
#
# This is the Cloudflare-only sibling of dns-only-inwx/. The two stacks
# were split because the INWX Terraform provider eagerly calls
# account.login during Configure() — even when no resource references it
# — which made a single dual-provider stack fail to plan whenever the
# user only had Cloudflare creds. Each stack now declares only the one
# provider it needs.
#
# HOW TO RUN:
#   cd terraform/stacks/dns-only-cloudflare
#   export TF_VAR_cloudflare_api_token="..."
#   terraform init
#   terraform plan -var-file=myapp.tfvars
#   terraform apply -var-file=myapp.tfvars

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

module "dns" {
  source = "../../modules/cloudflare-dns"

  domain     = var.domain
  subdomains = var.subdomains
  ipv4       = var.target_ipv4
  ipv6       = var.target_ipv6
  ttl        = var.dns_ttl
  proxied    = var.cloudflare_proxied
}
