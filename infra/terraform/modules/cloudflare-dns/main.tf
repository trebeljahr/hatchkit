# modules/cloudflare-dns — Reusable module for creating DNS records in Cloudflare.
#
# WHY A MODULE?
# Mirror of modules/inwx-dns, so every stack can swap DNS providers by
# switching which module it calls. The stack-level `dns_provider` variable
# decides which of the two gets count=1 and which gets count=0.
#
# ASSUMES THE ZONE ALREADY EXISTS.
# Cloudflare zones are a one-time setup: you either create them in the
# dashboard or via the standalone cf-import.sh script. This module does NOT
# create zones — it just looks up an existing one by name and writes records
# into it. That keeps the module simple and avoids accidentally creating
# empty zones during a `terraform plan`.
#
# PROXIED RECORDS.
# `var.proxied = true` makes records orange-cloud (traffic goes through
# Cloudflare's CDN/WAF). When a record is proxied, Cloudflare requires
# ttl = 1 (which it displays as "Auto"). If proxied = false, the record is
# gray-cloud — Cloudflare is only acting as an authoritative DNS server and
# you use whatever TTL you want.
#
# USAGE (from a stack):
#   module "dns" {
#     source     = "../../modules/cloudflare-dns"
#     domain     = "example.com"
#     subdomains = { "app" = "Main app", "api" = "API" }
#     ipv4       = "1.2.3.4"
#     ipv6       = "2a01:..."
#     proxied    = true
#   }

# Look up the existing Cloudflare zone by name. If it doesn't exist, the
# plan will fail loud and early — which is what we want, because silently
# creating a new zone is a much worse failure mode.
data "cloudflare_zone" "this" {
  name = var.domain
}

# A records for each subdomain.
#
# NAME HANDLING:
# The Cloudflare API expects names relative to the zone root. So for
# app.example.com, you set name = "app" (not "app.example.com"). The CF
# provider accepts the fully-qualified form too, but the short form is
# what the dashboard displays and matches the import format.
resource "cloudflare_record" "a" {
  for_each = var.subdomains

  zone_id = data.cloudflare_zone.this.id
  name    = each.key
  type    = "A"
  content = var.ipv4

  # ttl = 1 means "auto" in the Cloudflare API. Required when proxied = true,
  # otherwise the API rejects the record. For non-proxied records we use the
  # caller's chosen TTL.
  ttl     = var.proxied ? 1 : var.ttl
  proxied = var.proxied
}

# AAAA records — only created when an IPv6 address is provided.
#
# The `var.ipv6 != "" ? var.subdomains : {}` ternary makes for_each iterate
# over an empty map when ipv6 is unset, producing zero resources.
resource "cloudflare_record" "aaaa" {
  for_each = var.ipv6 != "" ? var.subdomains : {}

  zone_id = data.cloudflare_zone.this.id
  name    = each.key
  type    = "AAAA"
  content = var.ipv6
  ttl     = var.proxied ? 1 : var.ttl
  proxied = var.proxied
}
