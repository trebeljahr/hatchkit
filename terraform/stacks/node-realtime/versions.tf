# versions.tf — Pin provider versions so builds are reproducible.
#
# HOW THIS WORKS:
# Terraform downloads providers (plugins) from the Terraform Registry.
# This block tells it which ones you need and what versions are acceptable.
# After your first `terraform init`, a `.terraform.lock.hcl` file is created
# that pins the EXACT version + checksums — commit that file to git.
#
# GOTCHA: If you bump a version here, run `terraform init -upgrade` to
# update the lock file. Just changing this file alone won't do it.

terraform {
  required_version = ">= 1.5"

  required_providers {
    # Hetzner Cloud — creates servers, firewalls, SSH keys, etc.
    # Official provider, very stable.
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
      # ~> 1.45 means ">= 1.45.0 and < 2.0.0"
      # This is called a "pessimistic constraint" — it allows patch/minor
      # updates but blocks major version bumps that could break things.
    }

    # INWX — manages DNS records (A, AAAA, CNAME, MX, TXT, etc.)
    # Official provider from INWX themselves.
    inwx = {
      source  = "inwx/inwx"
      version = "~> 1.0"
    }

    # MinIO provider — manages S3-compatible buckets.
    # Despite the name, this isn't just for self-hosted MinIO. It speaks the
    # S3 protocol and works with any S3-compatible service: Hetzner Object
    # Storage, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, etc.
    # We use it here to create buckets on Hetzner Object Storage.
    minio = {
      source  = "aminueza/minio"
      version = "~> 3.2"
    }
  }
}
