# variables.tf — ota-updates stack.
#
# Nothing here is secret. The Cloudflare token comes from the
# CLOUDFLARE_API_TOKEN environment variable, which `hatchkit infra`
# sets to a token minted for the run (see main.tf).

variable "zone" {
  description = "Cloudflare zone that holds the hostname. Must already exist."
  type        = string
  default     = "ricoslabs.com"
}

variable "hostname" {
  description = "Custom Domain the Worker answers on. Baked into every app binary as updateUrl, so never change it casually."
  type        = string
  default     = "ota.ricoslabs.com"
}

variable "worker_name" {
  description = "Worker script name."
  type        = string
  default     = "ota-updates"
}

variable "bucket_name" {
  description = "R2 bucket that holds bundles and channel pointers for every app."
  type        = string
  default     = "ota-updates"
}

variable "bucket_location" {
  description = "R2 location hint (apac, eeur, enam, oc, weur, wnam). null lets Cloudflare choose."
  type        = string
  default     = null
}

variable "apps" {
  description = "Capacitor app ids the endpoint serves. Each gets its own publish token."
  type        = list(string)
  default = [
    "com.ricoslabs.raptorrunner",
    "com.ricoslabs.trackyourtime",
    "com.ricoslabs.tiao",
    "com.ricoslabs.mesozoicprotocol",
  ]
}

variable "channels" {
  description = "Channels devices may ask for (capacitor.config defaultChannel)."
  type        = list(string)
  default     = ["production", "beta"]
}

variable "download_ttl_seconds" {
  description = "How long a signed bundle link stays valid."
  type        = number
  default     = 1800
}

variable "pointer_cache_seconds" {
  description = "How long each Cloudflare location caches a channel pointer. A promote or rollback reaches every location within this time."
  type        = number
  default     = 60
}

variable "compatibility_date" {
  description = "Workers compatibility date."
  type        = string
  default     = "2026-10-01"
}
