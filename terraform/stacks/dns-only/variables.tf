# variables.tf — DNS-only stack. Points subdomains at an existing server.

# ---------------------------------------------------------------------------
# DNS provider selection
# ---------------------------------------------------------------------------

variable "dns_provider" {
  description = <<-EOT
    Which DNS provider to use. One of: "inwx", "cloudflare".

    "inwx"       — records are created in INWX's nameservers. You need
                   inwx_username + inwx_password.
    "cloudflare" — records are created in an existing Cloudflare zone.
                   You need cloudflare_api_token and the zone must already
                   exist (use the dashboard or cf-import.sh to create it).
  EOT
  type        = string
  default     = "inwx"

  validation {
    condition     = contains(["inwx", "cloudflare"], var.dns_provider)
    error_message = "dns_provider must be 'inwx' or 'cloudflare'."
  }
}

# ---------------------------------------------------------------------------
# INWX credentials
# ---------------------------------------------------------------------------
#
# NOTE: These are required even when dns_provider = "cloudflare".
# The INWX Terraform provider calls account.login during its Configure()
# step, before checking whether any resource actually uses it. Passing
# real creds keeps it quiet. In practice this isn't an imposition: the
# typical migration path is "INWX registrar + Cloudflare DNS", so the user
# has INWX creds anyway, and devops-cli also uses them post-apply to
# auto-update NS delegation at the registrar.

variable "inwx_username" {
  description = "INWX account username. Best set via TF_VAR_inwx_username env var. Required regardless of dns_provider — see variables.tf comment."
  type        = string
  sensitive   = true
  default     = ""
}

variable "inwx_password" {
  description = "INWX account password. Best set via TF_VAR_inwx_password env var. Required regardless of dns_provider — see variables.tf comment."
  type        = string
  sensitive   = true
  default     = ""
}

# ---------------------------------------------------------------------------
# Cloudflare credentials (used when dns_provider = "cloudflare")
# ---------------------------------------------------------------------------

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token with Zone:Zone:Edit + Zone:DNS:Edit on the target
    zone. Best set via TF_VAR_cloudflare_api_token env var.

    Default is a format-valid placeholder so the provider block sits idle
    when dns_provider = "inwx" (the CF provider validates token format at
    configure time even if no resource uses it).
  EOT
  type        = string
  sensitive   = true
  default     = "unused_placeholder_token_000000000000000"
}

variable "cloudflare_proxied" {
  description = "If true, records are orange-cloud (proxied through Cloudflare). Ignored when dns_provider = 'inwx'."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Zone / records
# ---------------------------------------------------------------------------

variable "domain" {
  description = "Base domain (e.g. 'example.com'). Must already exist as a zone at the chosen DNS provider."
  type        = string
}

variable "subdomains" {
  description = "Map of subdomain names to descriptions. Each gets A + AAAA records."
  type        = map(string)
}

variable "target_ipv4" {
  description = "IPv4 address of the existing server to point DNS records at."
  type        = string
}

variable "target_ipv6" {
  description = "IPv6 address of the existing server (optional, set empty to skip AAAA records)."
  type        = string
  default     = ""
}

variable "dns_ttl" {
  description = "TTL for DNS records in seconds. Ignored for proxied Cloudflare records."
  type        = number
  default     = 3600
}
