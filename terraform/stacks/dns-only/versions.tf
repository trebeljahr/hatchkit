# versions.tf — DNS-only stack. Creates A/AAAA records for an existing server.
# Used when deploying to an existing Coolify server — no new infra needed.

terraform {
  required_version = ">= 1.5"

  required_providers {
    inwx = {
      source  = "inwx/inwx"
      version = "~> 1.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}
