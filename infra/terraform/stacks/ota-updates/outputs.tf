# outputs.tf — ota-updates stack.

output "endpoint" {
  description = "updateUrl base for capacitor.config (append /updates, /stats, /channel_self)."
  value       = "https://${var.hostname}"
}

output "worker_name" {
  value = cloudflare_workers_script.ota.script_name
}

output "bucket_name" {
  value = cloudflare_r2_bucket.bundles.name
}

output "publish_tokens" {
  description = "Per-app publish tokens. Read one with `terraform output -json publish_tokens | jq -r '.[\"<app id>\"]'` and store it as OTA_PUBLISH_TOKEN in that app's GitHub environment."
  value       = { for app, token in random_password.publish_token : app => token.result }
  sensitive   = true
}
