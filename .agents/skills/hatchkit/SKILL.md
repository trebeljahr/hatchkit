---
name: hatchkit
description: Use when the user mentions Hatchkit, the hatchkit CLI, scaffolding a new full-stack app, deploying to Coolify/Hetzner/DNS, provisioning GlitchTip/Plausible/Resend/S3/email/Stripe, pushing dotenvx keys, wiring GitHub Pages, or debugging provider credentials. Start with `hatchkit status --json` before recommending next commands.
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
| `hatchkit backup status` | Live project backup results, stale/missing captures, timer and restore checks over Tailscale | yes: `--json` |
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
| `hatchkit create` | Scaffold/deploy flow for a new app. Interactive by default; every prompt has a flag, and `--yes` runs it unattended |
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
| `hatchkit sync` | Sync/deploy state for an existing Hatchkit project (incl. manifest `aliases[]` multi-hostname routing) |
| `hatchkit dns publish` | Upsert A/AAAA records for the manifest's domain + aliases (supports `--dry-run`) |
| `hatchkit plausible rename <old> <new>` | Move a Plausible site to a new domain, keeping stats history |
| `hatchkit listmonk user <project>` | Give a project its own Listmonk API user + roles and rewrite its env (`--dry-run` first; needs the `hatchkit-admin` keychain token; never pushes) |
| `hatchkit rename-domain` | Rename project domain and related deploy config |
| `hatchkit regen-infra` | Regenerate project infra files |
| `hatchkit provision s3` | Create project S3/R2 buckets and env entries |
| `hatchkit assets pull` | Mirror remote object storage assets locally |
| `hatchkit backup configure --config <path>` | Store backup-bucket S3 keys and restic recovery password in OS keychain |
| `hatchkit backup install [--dry-run]` | Install/update the backup host through Tailscale using Keychain credentials; preserve sources and recovery password |
| `hatchkit backup register --config <path> [--dry-run]` | Register explicit existing-project database/file sources; refuse replacing a different policy |
| `hatchkit backup alerts --to <email> --from <verified-ses-email> [--dry-run]` | Configure failure/overdue email using existing SES Keychain credentials |
| `hatchkit backup alert-test` | Send one test notification to the configured recipient |
| `hatchkit backup run` | Request a full backup on the configured host |
| `hatchkit backup plan --json` | Read the current project's intended backup policy, without claiming it is installed |
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
hatchkit config add plausible
hatchkit config add resend
hatchkit config add stripe
```

`hatchkit add <project> [services]` provisions project-scoped resources. Current
service names include `glitchtip`, `plausible`, `resend`, `s3`, and `email`.
`all` selects every supported service.

## Trigger conditions

Use Hatchkit context when the user mentions any of:

- Hatchkit or the `hatchkit` CLI
- scaffolding, making, starting, or creating a full-stack app/project
- deploying, syncing, or maintaining an app on user-owned infra
- wiring Coolify, Hetzner, DNS/Cloudflare, R2/S3, or Resend
- provisioning GlitchTip, Plausible, Resend, S3/R2, email, or Stripe
- pushing, showing, or rotating dotenvx keys
- wiring GitHub Pages for a static tool
- adopting an existing repo into Hatchkit conventions
- debugging provider credentials or setup failures

## Guard rails

- `hatchkit doctor` is safe and read-only. Use it freely for diagnosis.
- `hatchkit setup` and `config add` are interactive. Do not run them
  unattended unless the user gave flags/config for automation.
- `hatchkit create` can write files, initialize git, create GitHub repos,
  run Terraform, configure DNS, create Coolify apps, and deploy. Be explicit
  before starting it — driving it from flags does not lower the blast radius.
- `hatchkit add`, `remove`, `keys push`, `keys rotate`, `gh-pages`, `sync`,
  `rename-domain`, `regen-infra`, `provision s3`, and `destroy` can mutate local
  files and/or remote systems. Make sure the user's request authorizes that action.
- Never log secrets. `hatchkit keys show <project> --json` returns a live
  dotenvx private key. Only surface it when the user specifically asked.
- `hatchkit config reset` clears provider metadata and keychain entries. Confirm
  clearly before suggesting or running it.
- Prefer `HATCHKIT_CONF_DIR` for isolated test state instead of touching the
  user's real config during automated checks.
- For commands that could break an existing setup, default to reporting and
  handing the user commands instead of executing. Prefer `--dry-run`, `--json`,
  or `--recipe` modes where supported.
- Before running a mutating command, know its rollback path and tell the user.
  Examples: `hatchkit destroy <project> --recipe` prints the rollback recipe
  without executing; `hatchkit gh-pages --undo --dry-run` previews Pages undo;
  create/adopt write a run ledger so `hatchkit destroy <project>` can undo
  resources Hatchkit created. Do not run rollback/destructive cleanup without
  explicit user approval.
- Never assume Hatchkit owns pre-existing resources. Rollback ledgers are meant
  to avoid deleting user-owned state; preserve that model when fixing code.

## Backups for new projects

The backup provider is separate from app asset storage. Credentials live under
Keychain service `hatchkit`, account `backups:r2:credentials`; never print or copy
them into app environments. With `autoRegister: true`, create deployments on the
configured Coolify server register standard managed and Compose databases for
daily encrypted R2 backups, retaining three verified generations. Failures become
deferred steps with a registration retry command. External databases, custom
file mounts, other hosts, adopted projects and R2 asset objects require explicit
registration/coverage. A manifest policy is intent; inspect `backup status` for
actual capture and restore results. Backup host operations use Tailscale SSH with
no public-SSH fallback. Configure/install/register/run/alerts mutate state; alert-test sends email.
All require the user's applicable authorization. `status`, `plan`, and `--dry-run` are safe
read-only checks. The maintained bundle README documents installation, restore
drills, scheduling and how to disable the timer while keeping stored backups.

## Driving `hatchkit create` from flags

`hatchkit create` is interactive by default, but every question it asks has a
matching CLI flag. This is the path to prefer when acting for a user, because
it makes the plan reviewable before anything runs.

Precedence: a value passed as a flag is used as-is and **its prompt is
skipped**. Anything not passed is still prompted for, so partial flag sets
work — this is hybrid, not all-or-nothing.

`--yes` (alias `--non-interactive`) additionally takes defaults for whatever
is still unset and hard-fails, naming the missing flag, instead of prompting.
Pair it with `--dry-run` to print the fully-resolved plan without writing
anything:

```bash
hatchkit create --yes --dry-run --name blog --domain blog.example.com \
  --surfaces fullstack --deployment-mode coolify
```

Flags, with their valid values:

| Flag | Values |
|---|---|
| `--name <name>` | required under `--yes` |
| `--domain <host>` | defaults to `<name>.<root domain>` |
| `--description <text>` | pass empty for "none" |
| `--surfaces` | `fullstack` `split` `backend` `static` |
| `--deployment-mode` | `coolify` `gh-pages` `scaffold-only` (`gh-pages` needs `--surfaces static`) |
| `--deploy-target` | `new` `existing` |
| `--server-size` | `cpx21` `cpx31` `cpx41` |
| `--server-location` | `nbg1` `fsn1` `hel1` |
| `--server-id`, `--server-ip` | required with `--deploy-target existing` |
| `--features` | `websocket` `stripe` `analytics` `s3` `workspaces` `desktop` `mobile` `client-core` `extension` `release` `i18n` `raycast` `mcp` (comma-separated; `extension`, `raycast` and `mcp` need a `fullstack`/`split` surface; `raycast` and `mcp` pull in `client-core`, and `mcp` also needs `public-api`) |
| `--analytics-providers` | `glitchtip` `plausible` |
| `--services` | `glitchtip` `plausible` `listmonk-ses` `s3` `email` `search-console` |
| `--db-engine` | `mongodb` `postgres` |
| `--db-provider` | `coolify` `external` |
| `--s3-provider` | `hetzner` `r2` `aws` `existing` `none` |
| `--s3-endpoint`, `--s3-bucket`, `--s3-access-key`, `--s3-secret-key`, `--s3-region` | required with `--s3-provider existing` |
| `--email` | `none` `transactional` `mailing-list` `both` |
| `--email-forwarding` | `off`, or comma-separated local-parts |
| `--email-catch-all` / `--no-email-catch-all` | forward `*@domain` |
| `--ml-services` | `3d-sam-objects` `3d-sam-body` `3d-hunyuan` `3d-trellis` `3d-extraction` `subtitles` `image-recognition` `background-removal` `custom-hf` |
| `--gpu-platforms` | `modal` `runpod` `hf` `replicate` (first is default `ML_BACKEND`) |
| `--custom-hf-model`, `--custom-hf-gpu-type` | required with `--ml-services custom-hf` |
| `--scaffold` / `--no-scaffold` | write the app repo |
| `--github` / `--no-github`, `--github-visibility` (`private` `public`), `--public`, `--private` | GitHub remote |
| `--install` / `--no-install` | run `pnpm install` |
| `--deploy` / `--no-deploy` | run the deploy |
| `--local-dev[=<slug>]` / `--no-local-dev` | Tailscale dev URL |
| `--config <path>` | JSON `Partial<ProjectConfig>`; individual flags win over it |

Invalid values fail before anything is written, with the valid set in the
error. Run `hatchkit create --help` for the authoritative list.

Secrets on the command line end up in shell history — prefer `--config <path>`
for `--s3-secret-key`.

## When something breaks

If Hatchkit itself is breaking, diagnose and report before changing anything:

1. Capture the command, working directory, Hatchkit version, and relevant output.
2. Run safe checks first: `hatchkit status --json`, `hatchkit doctor --json`,
   and the relevant `hatchkit help <command>`.
3. Inspect the source files for the command path listed below.
4. Explain likely cause, blast radius, and rollback/undo options.
5. If the user wants another agent or a follow-up session to fix it, write a
   concrete repair prompt. Include the failing command/output, suspected files,
   expected behavior, safety constraints, and validation commands.

Repair prompts should tell the fixing agent to preserve existing user setups,
use `--dry-run`/isolated `HATCHKIT_CONF_DIR` where possible, and ask before any
real provider/DNS/Coolify/Terraform/keychain mutation.

## State locations

- CLI source: `cli/src/` (`cli/src/index.ts` entrypoint).
- Starter template: `starter/`.
- Infra templates/automation: `infra/`.
- MCP server: `mcp/`.
- Project manifest: `<project>/.hatchkit.json`.
- Provider metadata: path from `hatchkit status --json` (`configPath`).
- Secrets: OS keychain/libsecret, service `hatchkit`.
- Provisioned env blocks: `<config-dir>/provisioned/<project>.{dev,prod}.env`.

## Code map

- CLI router/help: `cli/src/index.ts`.
- Config, providers, keychain metadata: `cli/src/config.ts`.
- Status snapshots: `cli/src/status.ts`.
- Provider health checks and hints: `cli/src/doctor.ts`.
- Mental model output: `cli/src/explain.ts`.
- Project overview/inventory: `cli/src/overview.ts`, `cli/src/inventory.ts`.
- Scaffold flow: `cli/src/scaffold/`.
- Starter template copied into projects: `starter/`.
- Deploy/Coolify/Terraform/GitHub/GHCR/keys/pages: `cli/src/deploy/`.
- Rollback, destroy, run ledgers: `cli/src/deploy/rollback.ts`,
  `cli/src/utils/run-ledger.ts`.
- Provider provisioning: `cli/src/provision/`.
- DNS helpers: `cli/src/dns.ts`, `cli/src/utils/cloudflare-api.ts`.
- Assets mirror/sync: `cli/src/assets/`.
- MCP server for agents: `mcp/src/index.ts`.
- Docs source: `docs/content/docs/`.

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
