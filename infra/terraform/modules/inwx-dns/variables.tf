variable "domain" {
  description = "Base domain (e.g. 'example.com'). Must already exist as a zone in INWX."
  type        = string
}

variable "subdomains" {
  description = "Map of subdomain names to descriptions. Each gets A (and AAAA if ipv6 set) records."
  type        = map(string)
}

variable "ipv4" {
  description = "IPv4 address to point records at."
  type        = string
}

variable "ipv6" {
  description = "IPv6 address for AAAA records. Leave empty to skip AAAA."
  type        = string
  default     = ""
}

variable "ttl" {
  description = "TTL in seconds."
  type        = number
  default     = 3600
}
