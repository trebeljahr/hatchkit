# variables.tf — DNS-only Cloudflare stack.

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Zone:Read + Zone:DNS:Edit on the target zone. Best set via TF_VAR_cloudflare_api_token env var."
  type        = string
  sensitive   = true
}

variable "cloudflare_proxied" {
  description = "If true, records are orange-cloud (proxied through Cloudflare)."
  type        = bool
  default     = true
}

variable "domain" {
  description = "Base domain (e.g. 'example.com'). Must already exist as a zone in Cloudflare."
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
  description = "TTL for DNS records in seconds. Ignored for proxied Cloudflare records (CF forces ttl=1/auto)."
  type        = number
  default     = 3600
}
