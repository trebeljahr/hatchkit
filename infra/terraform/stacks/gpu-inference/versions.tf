# versions.tf — Pin provider versions so builds are reproducible.
#
# Same providers as node-realtime: Hetzner for the API server, INWX for DNS,
# MinIO/S3 for object storage. The GPU inference itself runs on an external
# platform (Modal, RunPod, AWS Batch) — not on the Hetzner server.
#
# The Hetzner server hosts the web API that receives uploads and dispatches
# GPU jobs. It does NOT need a GPU — a cpx21/cpx31 is plenty.

terraform {
  required_version = ">= 1.5"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }

    inwx = {
      source  = "inwx/inwx"
      version = "~> 1.0"
    }

    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }

    minio = {
      source  = "aminueza/minio"
      version = "~> 3.2"
    }
  }
}
