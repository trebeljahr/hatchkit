---
name: hatchkit
description: Use when the user mentions Hatchkit, the hatchkit CLI, scaffolding a new full-stack app, deploying to Coolify/Hetzner/DNS, provisioning GlitchTip/OpenPanel/Resend/S3/email/Stripe, pushing dotenvx keys, wiring GitHub Pages, or debugging provider credentials. Start with `hatchkit status --json` before recommending next commands.
---

# hatchkit

`hatchkit` is the CLI in this monorepo (`cli/`) for taking a product from idea to
running app on user-owned infra:

scaffold -> deploy -> provision -> maintain.

It creates full-stack TypeScript apps from `starter/`, can wire DNS/VPS/Coolify
via Terraform, provisions per-project clients for external services, manages
dotenvx encryption keys, and exposes JSON/MCP surfaces so agents can reason
about state without scraping human output.

## First principle: orient before acting

Before recommending a next Hatchkit command, run:

```bash
hatchkit status --json
```

Read:

- `providers[]` for configured providers and the exact `configureCommand`.
- `nextStep` for what the CLI thinks the user should do next.
- `suggestions[]` for safe follow-up commands.

These reflect the user's current machine state. Do not guess from memory.

If the user has `@hatchkit/mcp` configured, prefer the MCP status tool over a
shell command.

## Second principle: use machine output

Use JSON where available:

| Command | Purpose | JSON? |
|---|---|---|
| `hatchkit status` | Provider state and next step | yes: `--json` |
| `hatchkit doctor` | Live provider health checks | yes: `--json` |
| `hatchkit explain` | Mental model, commands, workflows, state | yes: `--json` |
| `hatchkit overview` | Project overview, optionally `--all` | yes: `--json` |
| `hatchkit keys show <project>` | Dotenvx private key lookup | yes: `--json` |

When a provider fails, run:

```bash
hatchkit doctor --json
```

Surface the failing `checks[].hint[]` lines. They already contain the credential
rotation URL, required scopes, and exact `hatchkit config add <provider>` command.

## Common commands

| Command | Use |
|---|---|
| `hatchkit setup` / `init` | One-time interactive onboarding for credentials |
| `hatchkit config` | Show configured provider status |
| `hatchkit config add <provider>` | Reconfigure one provider |
| `hatchkit create` | Interactive scaffold/deploy flow for a new app |
| `hatchkit update` | Add supported features to an existing Hatchkit project |
| `hatchkit add <project> [services]` | Provision per-project clients/env blocks |
| `hatchkit remove <project> [services]` | Unprovision selected project clients |
| `hatchkit keys show <project>` | Print stored dotenvx private key |
| `hatchkit keys push <project>` | Push dotenvx key to Coolify/GitHub Actions |
| `hatchkit keys rotate <project>` | Rotate dotenvx keypair |
| `hatchkit doctor` | Read-only live health check of configured providers |
| `hatchkit explain` | One-page mental model |
| `hatchkit gh-pages` | Wire GitHub Pages for the current repo |
| `hatchkit adopt` | Adopt an existing repo into Hatchkit conventions |
| `hatchkit sync` | Sync/deploy state for an existing Hatchkit project |
| `hatchkit rename-domain` | Rename project domain and related deploy config |
| `hatchkit regen-infra` | Regenerate project infra files |
| `hatchkit provision s3` | Create project S3/R2 buckets and env entries |
| `hatchkit assets pull` | Mirror remote object storage assets locally |
| `hatchkit inventory` | Infer/write `.hatchkit.json` metadata |
| `hatchkit completion <shell>` | Print shell completion |

Check `hatchkit help <command>` or `hatchkit <command> --help` before using flags
you have not verified.

## Providers and services

Provider config commands include:

```bash
hatchkit config add coolify
hatchkit config add ghcr
hatchkit config add hetzner
hatchkit config add dns
hatchkit config add s3
hatchkit config add modal
hatchkit config add runpod
hatchkit config add hf
hatchkit config add replicate
hatchkit config add glitchtip
hatchkit config add openpanel
hatchkit config add resend
hatchkit config add stripe
```

`hatchkit add <project> [services]` provisions project-scoped resources. Current
service names include `glitchtip`, `openpanel`, `resend`, `s3`, and `email`.
`all` selects every supported service.

## How users refer to Hatchkit

Treat these as Hatchkit context:

- "make/scaffold/start a new app/project"
- "wire this to Coolify/Hetzner/Cloudflare/R2/Resend"
- "push the dotenvx key"
- "why is provider setup failing?"
- "rotate my token/key"
- "add error tracking/analytics/email/S3"
- "deploy this on my own infra"
- "GitHub Pages for this static tool"
- "adopt this repo"

## Guard rails

- `hatchkit doctor` is safe and read-only. Use it freely for diagnosis.
- `hatchkit create`, `setup`, and `config add` are interactive. Do not run them
  non-interactively unless the user gave flags/config for automation.
- `hatchkit create` can write files, initialize git, create GitHub repos,
  run Terraform, configure DNS, create Coolify apps, and deploy. Be explicit
  before starting it.
- `hatchkit add`, `remove`, `keys push`, `keys rotate`, `gh-pages`, `sync`,
  `rename-domain`, `regen-infra`, `provision s3`, and `destroy` can mutate local
  files and/or remote systems. Make sure the user's request authorizes that action.
- Never log secrets. `hatchkit keys show <project> --json` returns a live
  dotenvx private key. Only surface it when the user specifically asked.
- `hatchkit config reset` clears provider metadata and keychain entries. Confirm
  clearly before suggesting or running it.
- Prefer `HATCHKIT_CONF_DIR` for isolated test state instead of touching the
  user's real config during automated checks.

## State locations

- CLI source: `cli/src/` (`cli/src/index.ts` entrypoint).
- Starter template: `starter/`.
- Infra templates/automation: `infra/`.
- MCP server: `mcp/`.
- Project manifest: `<project>/.hatchkit.json`.
- Provider metadata: path from `hatchkit status --json` (`configPath`).
- Secrets: OS keychain/libsecret, service `hatchkit`.
- Provisioned env blocks: `<config-dir>/provisioned/<project>.{dev,prod}.env`.

## MCP

If `@hatchkit/mcp` is configured, use the read-only tools before shelling out:

- `hatchkit_status` -> `StatusSnapshot`
- `hatchkit_doctor` -> `{ summary, checks[] }`
- `hatchkit_explain` -> mental model payload
- `hatchkit_keys_show({ project })` -> `{ project, found, key }`

The MCP server intentionally does not expose mutating commands.

## Repo development

For this monorepo:

```bash
pnpm install
pnpm --filter hatchkit run dev
pnpm --filter hatchkit run typecheck
pnpm --filter hatchkit run check
pnpm --filter hatchkit install-local
```

Use `pnpm --filter hatchkit run dev` to run the CLI from source. Use the published
or installed `hatchkit` binary for user-level state checks.
