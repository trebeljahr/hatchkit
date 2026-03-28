# outputs.tf — Values printed after terraform apply.

output "server_ipv4" {
  description = "Public IPv4 address of the server."
  value       = hcloud_server.main.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the server."
  value       = hcloud_server.main.ipv6_address
}

output "server_id" {
  description = "Hetzner Cloud server ID."
  value       = hcloud_server.main.id
}

output "ssh_command" {
  description = "SSH command to connect to the server."
  value       = "ssh root@${hcloud_server.main.ipv4_address}"
}

output "ansible_inventory_entry" {
  description = "Add this line to ansible/inventories/production/hosts.ini under [vps]."
  value       = "${hcloud_server.main.ipv4_address} ansible_user=root"
}

output "next_steps" {
  description = "What to do after terraform apply."
  value       = <<-EOT
    Server is provisioning. Next steps:

    1. Wait ~2 min for cloud-init to finish
       Check: ssh root@${hcloud_server.main.ipv4_address} 'test -f /var/lib/cloud/instance/hardening-init-done && echo READY'

    2. Add to Ansible inventory:
       echo '${hcloud_server.main.ipv4_address} ansible_user=root' >> ansible/inventories/production/hosts.ini

    3. Run full hardening:
       make harden

    4. (Optional) Install Tailscale for zero-trust SSH:
       Set tailscale_enabled=true and tailscale_auth_key in inventory group_vars

    See docs/hardening-guide.md for manual steps and deep explanations.
  EOT
}
