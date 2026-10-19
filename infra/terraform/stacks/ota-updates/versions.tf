# versions.tf — ota-updates stack.

terraform {
  required_version = ">= 1.5"

  required_providers {
    # v5: the Workers resources (script bindings, custom domain, workers.dev
    # toggle) used here only exist in this shape from 5.x on.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
