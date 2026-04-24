# main.tf — DNS-only stack. Creates A/AAAA records for an existing server.
#
# Use this when deploying a new app to an existing Coolify server.
# No new server is created — just DNS records pointing at the existing IP.
#
# DNS PROVIDER CHOICE.
# Set `dns_provider = "inwx"` (default, records land in INWX's nameservers)
# or `dns_provider = "cloudflare"` (records land in an existing Cloudflare
# zone). The unused module is gated to count=0, so only the chosen provider
# makes API calls during apply.
#
# HOW TO RUN:
#   cd terraform/stacks/dns-only
#   # pick one provider path:
#   export TF_VAR_inwx_username="..."            # INWX path
#   export TF_VAR_inwx_password="..."
#   # OR
#   export TF_VAR_cloudflare_api_token="..."     # Cloudflare path
#   terraform init
#   terraform plan -var-file=myapp.tfvars
#   terraform apply -var-file=myapp.tfvars

# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
#
# Both providers are declared unconditionally. Terraform initializes a
# provider only when a resource (or data source) actually references it,
# so the unused one sits idle with empty credentials and never calls its
# API. If you try to use a provider with empty credentials by accident,
# you'll get a clear auth error rather than silent success.

provider "inwx" {
  username = var.inwx_username
  password = var.inwx_password
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ---------------------------------------------------------------------------
# DNS records — dispatched to one of two modules based on var.dns_provider.
# ---------------------------------------------------------------------------
#
# The `count = var.dns_provider == "X" ? 1 : 0` pattern gates each module.
# Exactly one of these evaluates to count=1. The other is count=0, which
# means "zero instances" — no resources, no provider calls. This is the
# standard Terraform idiom for "pick one of two implementations".

module "dns_inwx" {
  count  = var.dns_provider == "inwx" ? 1 : 0
  source = "../../modules/inwx-dns"

  domain     = var.domain
  subdomains = var.subdomains
  ipv4       = var.target_ipv4
  ipv6       = var.target_ipv6
  ttl        = var.dns_ttl
}

module "dns_cloudflare" {
  count  = var.dns_provider == "cloudflare" ? 1 : 0
  source = "../../modules/cloudflare-dns"

  domain     = var.domain
  subdomains = var.subdomains
  ipv4       = var.target_ipv4
  ipv6       = var.target_ipv6
  ttl        = var.dns_ttl
  proxied    = var.cloudflare_proxied
}
