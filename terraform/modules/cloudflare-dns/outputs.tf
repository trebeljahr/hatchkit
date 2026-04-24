output "zone_id" {
  description = "Cloudflare zone ID."
  value       = data.cloudflare_zone.this.id
}

output "name_servers" {
  description = "Cloudflare-assigned nameservers for this zone. Point your registrar at these to activate the zone."
  value       = data.cloudflare_zone.this.name_servers
}
