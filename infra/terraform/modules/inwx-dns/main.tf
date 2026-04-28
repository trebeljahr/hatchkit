# modules/inwx-dns — Reusable module for creating DNS records at INWX.
#
# WHY A MODULE?
# If you have multiple stacks (chess-server, chat-app, staging), each needs DNS
# records. Instead of copy-pasting the inwx_nameserver_record blocks, you
# call this module with different parameters.
#
# HOW MODULES WORK:
# A module is just a directory with .tf files. You call it from your stack
# with a `module` block. It has its own variables (inputs) and outputs.
# Think of it like a function in a programming language.
#
# USAGE (from a stack):
#   module "dns" {
#     source     = "../../modules/inwx-dns"
#     domain     = "example.com"
#     subdomains = { "app" = "Main app", "api" = "API" }
#     ipv4       = "1.2.3.4"
#     ipv6       = "2a01:..."
#   }

resource "inwx_nameserver_record" "a" {
  for_each = var.subdomains

  domain  = var.domain
  name    = "${each.key}.${var.domain}"
  type    = "A"
  content = var.ipv4
  ttl     = var.ttl
}

resource "inwx_nameserver_record" "aaaa" {
  for_each = var.ipv6 != "" ? var.subdomains : {}
  # Only create AAAA records if an IPv6 address is provided.
  # The ternary `condition ? true_val : false_val` works with for_each:
  # if ipv6 is empty, we pass an empty map, so no resources are created.

  domain  = var.domain
  name    = "${each.key}.${var.domain}"
  type    = "AAAA"
  content = var.ipv6
  ttl     = var.ttl
}
