# dev-ops-automation

Opinionated, reusable infrastructure for deploying small SaaS apps on dedicated VPS instances through Coolify. Terraform for provisioning, shell scripts for Coolify API automation, Ansible for server hardening.

## Philosophy

- **Coolify is the deployment control plane.** It handles containers, reverse proxy (Traefik), TLS certs (Let's Encrypt), and deploy triggers.
- **App code lives in its own repo** and ships as a Docker image via GitHub Actions → GHCR → Coolify webhook.
- **Tailscale for admin access.** SSH over the tailnet, not the public internet.
- **One VPS per environment.** Small apps share a box. When something outgrows it, give it its own.
- **Don't self-host what you can buy cheaply.** Use managed services (Hetzner Object Storage, Sentry, Mailgun) until you have enough projects to justify a shared services box.

## What this repo gives you

```
.
├── terraform/
│   ├── stacks/node-realtime/     # Stampable infra: server + DNS + S3 bucket
│   ├── stacks/gpu-inference/     # API server + dual S3 buckets for photo-to-3D
│   └── modules/inwx-dns/        # Reusable DNS module
├── stacks/
│   ├── node-realtime.env.example # Coolify app config template
│   └── gpu-inference.env.example # GPU inference API config template
├── scripts/
│   ├── create-hetzner-server.sh  # Thin wrapper around hcloud CLI
│   ├── install-coolify.sh        # Installs Coolify on the server
│   ├── repair-coolify-network.sh # Fixes the IPv6 Docker network bug
│   └── verify-coolify.sh         # Post-install verification
├── ansible/
│   ├── playbooks/bootstrap.yml   # Server hardening + base packages
│   └── roles/                    # base, ssh_hardening, tailscale
├── cloud-init/
│   └── ubuntu-24.04-coolify.yaml # First-boot provisioning
├── templates/
│   ├── apps/node-express-websocket/
│   ├── apps/gpu-inference-api/   # FastAPI + Modal/RunPod GPU dispatch
│   └── services/uptime-kuma/
├── docs/                         # Runbooks and decision records
└── Makefile                      # Orchestrates everything
```

## How it all fits together

There are two phases to setting up a new project:

### Phase 1: Infrastructure (Terraform)

Creates the Hetzner server, Hetzner Cloud firewall, INWX DNS records (A + AAAA for all subdomains), and an S3 bucket on Hetzner Object Storage.

```bash
cd terraform/stacks/node-realtime
cp terraform.tfvars.example terraform.tfvars  # fill in your values

export TF_VAR_hcloud_token="..."
export TF_VAR_inwx_username="..."
export TF_VAR_inwx_password="..."
export TF_VAR_s3_access_key="..."
export TF_VAR_s3_secret_key="..."

make tf-init STACK=myapp
make tf-plan STACK=myapp    # always review the plan first
make tf-apply STACK=myapp
```

### Phase 2: Server bootstrap (Ansible + Coolify)

After the server is up (~2 min for cloud-init), harden it and install Coolify:

```bash
make bootstrap INVENTORY=ansible/inventories/production/hosts.ini
./scripts/install-coolify.sh
```

### Phase 3: App stack (Coolify API)

The `hatchkit` CLI (in `../cli`) creates the Coolify project, the application resource linked to your GitHub repo, optional per-project MongoDB, encrypted `.env.production` via dotenvx, and pushes the GitHub Actions deploy secrets:

```bash
hatchkit create     # interactive — runs Terraform + Coolify in one flow
```

`hatchkit create` auto-wires:
- `MONGODB_URI` pointing to the MongoDB container on the internal Docker network (encrypted in `.env.production` via dotenvx)
- S3 bucket name, endpoint, and region from your configured S3 provider
- `COOLIFY_BASE_URL`, `COOLIFY_API_TOKEN`, and per-app deploy webhooks as GitHub Actions secrets
- The dotenvx private key on the Coolify app so the runtime can decrypt `.env.production`

## Stamping a new project

To deploy a new app that fits the node-realtime pattern (Node.js + WebSocket + MongoDB + optional Redis + S3), use the `hatchkit` CLI:

```bash
hatchkit create     # interactive — picks deploy target, scaffolds repo, runs Terraform + Coolify
```

The CLI handles every step the manual workflow used to: tfvars + DNS, Coolify project + application, MongoDB provisioning, dotenvx-encrypted `.env.production`, and GitHub Actions deploy secrets. If the app goes on an **existing server** (you already have Coolify running), pick "Existing Coolify server" at the prompt and the CLI skips the Hetzner / Ansible / install-coolify steps.

## Domain routing

Each app gets automatic multi-domain routing. Setting `APP_DOMAIN=myapp.example.com` in the stack `.env` file creates:

| URL | Purpose |
|-----|---------|
| `https://myapp.example.com` | Frontend |
| `https://api.myapp.example.com` | API via subdomain |
| `https://myapp.example.com/api` | API via path (same-origin, no CORS) |
| `https://myapp.example.com/api/ws` | WebSocket via path |
| `https://api.myapp.example.com/ws` | WebSocket via subdomain |

Both the base domain and `api.*` subdomain need DNS records. The Terraform `subdomains` map handles this:

```hcl
subdomains = {
  "myapp"     = "Frontend + API paths"
  "api.myapp" = "Dedicated API subdomain"
}
```

Traefik (via Coolify) routes all listed domains to the same container. Path-based routing (`/api`, `/api/ws`) is handled inside your Express app, not by Traefik.

## External services & accounts

### Shared across all projects (set up once)

| Service | What it does | Env vars | Notes |
|---------|-------------|----------|-------|
| **Hetzner Cloud** | VPS hosting | `TF_VAR_hcloud_token` | One project per environment |
| **Hetzner Object Storage** | S3-compatible file storage | `TF_VAR_s3_access_key`, `TF_VAR_s3_secret_key` | 4.99 EUR/mo for 1 TB. One account, one bucket per app |
| **INWX** | Domain DNS management | `TF_VAR_inwx_username`, `TF_VAR_inwx_password` | Or your registrar of choice |
| **GitHub** | Code hosting + CI/CD | `gh auth login` | Actions builds Docker images, pushes to GHCR |
| **GlitchTip** | Error tracking + stack traces | `GLITCHTIP_DSN` | Self-hosted, Sentry SDK-compatible. Deploy on shared services VPS |
| **Plausible** | Privacy-friendly web analytics | `PLAUSIBLE_DOMAIN` | $9/mo hosted. Self-host later on a shared services box |

### Per-project (set up for each new app)

| Service | What it does | Env vars | Notes |
|---------|-------------|----------|-------|
| **Stripe** | Payments & subscriptions | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Free until you charge. Webhook → `https://api.<domain>/stripe/webhook` |
| **Mailgun** | Transactional email (signup, password reset) | `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` | Requires DNS records for domain verification (SPF, DKIM) |
| **Coolify** | Deployment control plane | `COOLIFY_URL`, `COOLIFY_TOKEN` | API token from Settings > API Tokens in dashboard |

### How to decide: hosted vs. self-hosted

**Start hosted, self-host when it makes financial sense.**

| Service | Hosted cost | Self-hosted option | When to switch |
|---------|------------|-------------------|----------------|
| Error tracking | GlitchTip (self-hosted) | — | Deploy on shared services VPS from day one. Uses Sentry SDKs, no vendor lock-in |
| Analytics | Plausible $9/mo | Plausible CE (~1.5 GB RAM, needs ClickHouse) | When you have 3+ projects and a shared services VPS |
| Uptime monitoring | Free tiers exist | Uptime Kuma (~100 MB RAM) | Immediately — it's lightweight, deploy as a Coolify Service |
| Object storage | Hetzner Object Storage 4.99 EUR/mo | — | Keep it managed; object storage is cheaper and safer than self-hosting |

When you have 2-3 projects and the hosted costs add up, spin up a **shared services VPS** (cpx11, ~4 EUR/mo) running GlitchTip + Plausible CE + Uptime Kuma. All your app servers point at this one box.

## S3 storage strategy

**One Hetzner Object Storage account, one bucket per app.**

- Billing is per-account (4.99 EUR/mo for 1 TB across all buckets), not per-bucket
- Separate buckets = clean isolation (credentials, lifecycle policies, easy deletion)
- Same S3 credentials work for all buckets in the same Hetzner project
- Terraform creates the bucket via an S3-compatible Terraform provider

The Coolify setup script auto-reads bucket info from Terraform output, and picks up S3 credentials from your `TF_VAR_s3_access_key` / `TF_VAR_s3_secret_key` environment variables.

## VPS sizing guide

| Size | Specs | Good for |
|------|-------|----------|
| cpx21 | 3 vCPU / 4 GB / 80 GB | One app + managed DBs (MongoDB Atlas, etc.) |
| cpx31 | 4 vCPU / 8 GB / 160 GB | One app + self-hosted MongoDB + Redis, or 2-3 small apps |
| cpx41 | 8 vCPU / 16 GB / 240 GB | Multiple apps with self-hosted databases and observability |

RAM budget on a cpx21 (4 GB):

| Component | RAM |
|-----------|-----|
| OS + Coolify + Traefik | ~1 GB |
| Your Node.js app | ~200-400 MB |
| MongoDB | ~300-500 MB |
| Redis | ~50 MB |
| **Available headroom** | **~2 GB** |

## Stampable deployment profiles

These are documented in `docs/coolify-stamps.md`:

- **node-web-http**: Plain HTTP request/response app. Easiest to run.
- **node-realtime-single**: Node + WebSockets, single replica. Brief reconnects during deploys. *(This is what the Terraform stack automates.)*
- **node-realtime-ha**: Node + WebSockets, 2+ replicas, shared state via Redis pubsub. Near-zero downtime.
- **node-api-postgres**: CRUD/API apps with PostgreSQL.
- **node-api-mongo**: Document-heavy apps with MongoDB.
- **gpu-inference**: FastAPI server that dispatches to external GPU platforms (Modal, RunPod, AWS Batch). Dual S3 buckets for uploads + generated models. *(See `docs/gpu-inference-pipeline.md` for platform comparison and cost analysis.)*

## GPU inference stack

For ML workloads (image processing, 3D model generation, etc.) that need GPU:

```bash
# 1. Scaffold the project + provision infra + create the Coolify app
hatchkit create     # interactive — pick the gpu-inference template

# 2. Deploy GPU pipeline to Modal (recommended for V1)
cd templates/apps/gpu-inference-api/modal
pip install modal && modal setup
modal deploy pipeline.py
```

The Hetzner server runs the web API (receives uploads, dispatches jobs, serves results). GPU inference runs on an external platform that scales to zero. See `docs/gpu-inference-pipeline.md` for:
- Platform comparison (Modal vs RunPod vs AWS Batch)
- 3D reconstruction model benchmarks (SF3D, TripoSR, TRELLIS.2)
- Cost analysis and cold start strategies
- Migration path from external platforms to self-hosted

## Zero downtime notes

For plain HTTP apps, Coolify + health checks gets you very close to zero downtime on one server.

For WebSocket apps, single-replica deployments **will** drop active connections during deploys. To get near-zero downtime you need:
- 2+ app replicas
- Externalized state (no process-local WebSocket registries)
- Shared pubsub (Redis) for cross-replica message fanout
- Graceful shutdown (handle SIGTERM, drain connections)
- Client-side reconnect logic

See `docs/zero-downtime-realtime.md`.

## Security model

Documented in `docs/security-and-admin-access.md`:

- **SSH**: key-only auth, password auth disabled (Ansible `ssh_hardening` role)
- **Admin access**: Tailscale preferred. SSH over the tailnet, not the public internet.
- **Firewall**: Hetzner Cloud firewall allows only 22 (SSH), 80 (HTTP), 443 (HTTPS). Bootstrap port 8000 is closed after Coolify setup.
- **Secrets**: never in `.tf` files or committed `.env` files. Use `TF_VAR_` environment variables for Terraform, Coolify encrypted storage for app secrets.
- **State files**: `.tfstate` contains all resource attributes including secrets. Never commit it. Use remote state (S3 backend) for teams.

## Makefile targets

```
make help              # Show all targets

# Server bootstrap
make bootstrap         # Run Ansible hardening playbook
make verify            # Verify Coolify installation

# Terraform (infra + DNS + S3)
make tf-init   STACK=<name>   # Initialize providers
make tf-plan   STACK=<name>   # Preview changes (always do this first)
make tf-apply  STACK=<name>   # Apply changes
make tf-destroy STACK=<name>  # Tear down infrastructure
```

For end-to-end project creation (Terraform + Coolify app + MongoDB + GitHub secrets), use `hatchkit create` from the `cli/` package — it orchestrates the same Makefile targets and the Coolify REST API in one interactive flow.

## Terraform providers used

| Provider | Source | Purpose |
|----------|--------|---------|
| hcloud | `hetznercloud/hcloud` | Servers, firewalls, SSH keys |
| inwx | `inwx/inwx` | DNS records (A, AAAA) |
| minio | `aminueza/minio` | S3-compatible bucket creation on Hetzner Object Storage |

**Why no Coolify Terraform provider?** The community provider ([SierraJC/coolify](https://github.com/SierraJC/terraform-provider-coolify)) is 0.x with partial application/database support. The Coolify REST API is complete and stable, so we use it directly from the CLI (see `cli/src/utils/coolify-api.ts` and `cli/src/deploy/coolify.ts`). When the provider matures, the migration is straightforward — the concepts map 1:1.

## References

- [Coolify docs](https://coolify.io/docs)
- [Coolify API reference](https://coolify.io/docs/api-reference/api/operations/version)
- [Hetzner Cloud docs](https://docs.hetzner.com/cloud/)
- [Hetzner Object Storage](https://docs.hetzner.com/storage/object-storage/overview/)
- [INWX Terraform provider](https://registry.terraform.io/providers/inwx/inwx/latest/docs)
- [Terraform provider for S3-compatible buckets](https://github.com/aminueza/terraform-provider-minio) (used for Hetzner Object Storage buckets)
- [Tailscale Linux install](https://tailscale.com/docs/install/linux)
- [Plausible CE](https://github.com/plausible/community-edition)
- [GlitchTip](https://glitchtip.com) (self-hosted error tracking, Sentry SDK-compatible)
