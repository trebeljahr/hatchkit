# Fresh VPS bootstrap

## Starting size
- `2 vCPU / 4 GB RAM / 40-80 GB SSD`: good if Mongo/object storage/email stay managed.
- `4 vCPU / 8 GB RAM / 80-160 GB SSD`: better if you will self-host Mongo, build images on the same box, or add observability tooling.

## Provisioning flow
1. Create the server with Ubuntu 24.04 and your SSH key.
2. Feed `cloud-init/ubuntu-24.04-coolify.yaml` into server creation.
3. SSH in and confirm cloud-init finished: `cloud-init status`.
4. Run the Ansible bootstrap playbook.
5. Install Coolify on the server.
6. Put the Coolify dashboard on HTTPS.
7. Close bootstrap-only ports publicly.
8. Add Tailscale and confirm SSH over the tailnet.
9. Configure backups and notifications.

## Hetzner example
Use `scripts/create-hetzner-server.sh` after setting:
- `SSH_KEY_NAME`
- optional `NAME`, `TYPE`, `LOCATION`, `FIREWALL`

## Minimal public ports after setup
- `22/tcp`: SSH, or close publicly once Tailscale-only admin is in place.
- `80/tcp` and `443/tcp`: public web traffic.

## Bootstrap-only ports
These are only needed while bringing up Coolify directly by IP:
- `8000/tcp`
- `6001/tcp`
- `6002/tcp`

Once the dashboard works on a real domain over HTTPS, close those ports publicly.
