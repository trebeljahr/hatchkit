# main.tf — ota-updates: live-update endpoint for @capgo/capacitor-updater.
#
# One Worker on the Custom Domain ota.ricoslabs.com plus one R2 bucket
# serve every app in var.apps. The Worker code and its tests live in
# infra/ota-updates/ (README.md there has the protocol and operations).
#
#   R2 bucket        bundles + per-channel, per-native-line pointers
#   Worker           update checks, signed downloads, per-app publish API
#   Custom Domain    ota.ricoslabs.com → Worker (creates the DNS record)
#   workers.dev      off: no Cache API there, and one hostname to reason about
#
# Secrets are generated here (random provider) and live only in the local,
# gitignored state and in the Worker's secret bindings:
#   URL_SIGNING_KEY       HMAC key for the short-lived /dl/ links
#   PUBLISH_TOKEN_HASHES  SHA-256 of each app's publish token
# The tokens themselves are the sensitive output `publish_tokens`; each
# goes into its app's GitHub environment as OTA_PUBLISH_TOKEN.
#
# HOW TO RUN (never with hatchkit's own token):
#   hatchkit infra plan ota-updates     # mints a 1 h token, plans, saves tfplan
#   hatchkit infra apply ota-updates    # applies that saved plan with a fresh token

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment. Not a variable on
  # purpose: a saved plan stores variable values, and `apply` runs with a
  # newer per-run token than the one `plan` used.
}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone
  }
}

locals {
  account_id  = data.cloudflare_zone.this.account.id
  zone_id     = data.cloudflare_zone.this.zone_id
  worker_file = "${path.module}/../../../ota-updates/worker.js"
}

resource "cloudflare_r2_bucket" "bundles" {
  account_id = local.account_id
  name       = var.bucket_name
  location   = var.bucket_location
}

resource "random_password" "url_signing_key" {
  length  = 64
  special = false
}

resource "random_password" "publish_token" {
  for_each = toset(var.apps)

  length  = 48
  special = false
}

resource "cloudflare_workers_script" "ota" {
  account_id         = local.account_id
  script_name        = var.worker_name
  main_module        = "worker.js"
  content_file       = local.worker_file
  content_sha256     = filesha256(local.worker_file)
  compatibility_date = var.compatibility_date

  bindings = [
    {
      name        = "BUCKET"
      type        = "r2_bucket"
      bucket_name = cloudflare_r2_bucket.bundles.name
    },
    {
      name = "APPS"
      type = "plain_text"
      text = jsonencode(var.apps)
    },
    {
      name = "CHANNELS"
      type = "plain_text"
      text = jsonencode(var.channels)
    },
    {
      name = "DOWNLOAD_TTL_SECONDS"
      type = "plain_text"
      text = tostring(var.download_ttl_seconds)
    },
    {
      name = "POINTER_CACHE_SECONDS"
      type = "plain_text"
      text = tostring(var.pointer_cache_seconds)
    },
    {
      name = "URL_SIGNING_KEY"
      type = "secret_text"
      text = random_password.url_signing_key.result
    },
    {
      name = "PUBLISH_TOKEN_HASHES"
      type = "secret_text"
      text = jsonencode({ for app, token in random_password.publish_token : app => sha256(token.result) })
    },
  ]

  observability = {
    enabled            = true
    head_sampling_rate = 1
  }
}

resource "cloudflare_workers_script_subdomain" "ota" {
  account_id       = local.account_id
  script_name      = cloudflare_workers_script.ota.script_name
  enabled          = false
  previews_enabled = false
}

resource "cloudflare_workers_custom_domain" "ota" {
  account_id = local.account_id
  zone_id    = local.zone_id
  hostname   = var.hostname
  service    = cloudflare_workers_script.ota.script_name
}
