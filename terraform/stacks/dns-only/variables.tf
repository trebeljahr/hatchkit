# variables.tf — DNS-only stack. Points subdomains at an existing server.

variable "inwx_username" {
  description = "INWX account username. Best set via TF_VAR_inwx_username env var."
  type        = string
  sensitive   = true
}

variable "inwx_password" {
  description = "INWX account password. Best set via TF_VAR_inwx_password env var."
  type        = string
  sensitive   = true
}

variable "domain" {
  description = "Base domain managed in INWX (e.g. 'example.com')."
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
  description = "TTL for DNS records in seconds."
  type        = number
  default     = 3600
}
