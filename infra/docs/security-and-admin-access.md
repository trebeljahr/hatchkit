# Security and admin access

## Recommended admin model
- Tailscale for routine admin traffic.
- Key-only SSH.
- `PermitRootLogin prohibit-password` or a non-root admin user.
- Hetzner Cloud Firewall for network policy.

## Public exposure
Public:
- 80/tcp
- 443/tcp

Temporary during bootstrap only:
- 8000/tcp
- 6001/tcp
- 6002/tcp

## Practical hardening checklist
- Cloud firewall in place.
- Bootstrap-only ports closed publicly after HTTPS works.
- Tailscale installed.
- SSH passwords disabled.
- Fail2ban enabled.
- Unattended upgrades enabled.
- Backups stored off the box.
- Separate secrets per app, DB, bucket, and email provider.

## Isolation expectations
Containers help, but they are not VMs.
If one app is compromised, assume its container, env vars, and mounted data are exposed.
Do not share DB users, bucket credentials, or Docker networks across unrelated apps unless needed.
