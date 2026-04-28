# versions.tf — DNS-only INWX stack.

terraform {
  required_version = ">= 1.5"

  required_providers {
    inwx = {
      source  = "inwx/inwx"
      version = "~> 1.0"
    }
  }
}
