---
name: hatchkit
description: Use for Hatchkit CLI scaffolding, deployment, provider setup, project maintenance, backups, and host checks. Start with `hatchkit status --json` before recommending operational commands.
---

# Hatchkit

Hatchkit scaffolds TypeScript apps, configures providers, deploys to user-owned infrastructure, and maintains project state. The repository's CLI lives in `cli/`.

## Orient before acting

Before recommending an operational command, run `hatchkit status --json`. Read `providers[]`, `nextStep`, and `suggestions[]`; use the returned `configureCommand` rather than guessing provider names. If the operator MCP server is configured, prefer `hatchkit_status`, `hatchkit_doctor`, and `hatchkit_explain`.

| Command | Purpose |
|---|---|
| `hatchkit status --json` | Configured providers and suggested next steps |
| `hatchkit doctor --json` | Read-only live checks and actionable `checks[].hint[]` entries |
| `hatchkit explain --json` | Concepts, command families, workflows, and state paths |
| `hatchkit overview --json` | Fleet resources and cross-provider inconsistencies |
| `hatchkit inventory --json` | Infer project identity and inspect matching resources; `--save` writes a manifest |
| `hatchkit backup status --json` | Actual captures, source validity, timers, and restore results |
| `hatchkit keys show PROJECT --json` | Return a live dotenvx key, only when explicitly requested |

Credential denial means a check is unverified. Do not report it as an invalid credential or a healthy check.

## Authority and credentials

- Follow the user's authorized scope. Create, adopt, add/remove, sync, keys/secrets, migrations, hosting setup, backup configuration, and host installation can write local or remote state.
- `doctor` is read-only; `doctor --fix` writes providers. Read a subcommand's help before assuming its JSON or dry-run flags make it read-only.
- Keep `HATCHKIT_KEYCHAIN_ACCESS=deny` during automated work. Live access needs an authorized interactive run or explicit authorization for `HATCHKIT_KEYCHAIN_ACCESS=allow`.
- After a denied credential read, stop that credential-dependent operation. Do not retry through another runtime or `/usr/bin/security`, weaken ACLs, or export credentials.
- Run CLI tests through `pnpm --filter hatchkit test` or `pnpm --filter hatchkit exec node scripts/test.mjs test-<name>.ts`. The runner replaces keytar with a temporary fixture store for tests and children. `HATCHKIT_CONF_DIR` and `HATCHKIT_KEYTAR_SERVICE` alone do not isolate the OS keychain.
- Never print secrets without an explicit request. `keys show` and `hatchkit_keys_show` return secrets. Provider metadata belongs in config; credentials belong in the keychain.
- `config reset` clears provider metadata and keychain entries. Confirm the intended reset before running it.
- Review changes to existing deployments before applying them. Prefer supported `--dry-run` or `--recipe` paths. Dry-runs can still read hosts/providers and execute preflight probes.
- Know the recovery path before a mutation. `destroy PROJECT --recipe` prints rollback steps. `gh-pages --undo --dry-run` and `cloudflare --undo --dry-run` preview their respective cleanup.
- Removal requires recorded ownership and exact identities. Names, cached credentials, and adoption are not proof. Retain ambiguous or legacy resources. Search Console property ownership is not established for removal.
- A deferred step may have created some resources before failing. Inspect its reason, ledger, and provider state before retrying.

## Choose the command family

Use `hatchkit help <command>` for current options. The families below have different side effects.

| Family | Use |
|---|---|
| `setup` / `init`, `config add` | Interactive provider onboarding |
| `create`, `update`, `server add` | Scaffold a project, add features, or restore server source to a static project |
| `adopt`, `adopt --resume` | Review and wire an existing repository; can create resources, commit, push, and deploy |
| `add PROJECT SERVICES`, `remove PROJECT SERVICES` | Provision services or remove ledger-owned resources |
| `destroy PROJECT` | Reverse recorded create/adopt actions; preview with `--recipe` |
| `sync` | Reconcile runtime env, routing, deploy hooks/secrets, and generated config; writes can occur without `--deploy` |
| `regen-infra` | Regenerate tfvars and Coolify stack env files; does not apply Terraform |
| `keys show/push/rotate`, `secrets rotate/isolate` | Inspect, deliver, rotate, or isolate credentials |
| `gh-pages`, `cloudflare` | Configure static hosting and repository deployment credentials |
| `cloudflare token`, `https`, `redirect` | Manage Worker CI credentials or host-specific zone redirects |
| `migrate-client`, `migrate-runtime`, `migrate-domain` | Move client hosting, runtime, or live provider identities |
| `rename-domain`, `rename-project`, `set-description` | Update identity; inspect optional remote effects |
| `dns publish`, `link-to-cloudflare` | Reconcile records or registrar nameservers |
| `provision s3`, `assets` | Provision buckets or copy/list objects |
| `email`, `ses`, `listmonk`, `plausible`, `stripe` | Provider-specific setup and maintenance (`stripe sync` writes products, prices and the paid-unlock webhook; `--dry-run` first) |
| `signing org-init/apply` | Configure signing providers and project artifacts; dry-run can read GitHub |
| `release plan/cut/status/check` | Inspect release channels, cut a local commit/tag, or read progress; cut never pushes |
| `backup` | Configure hosts, register sources, capture, inspect, or restore data |
| `host integrity`, `host updates` | Read host findings; install/uninstall change schedules and test sends email |
| `audit cloudflare` | Read account drift; accept/forget change local expectations, deploy/publish write remotely |
| `mac-runner status/on/off/run/serve` | Inspect or run private-repo Apple CI on this Mac |
| `infra plan/apply/output` | Manage maintained Terraform stacks; apply changes remote resources |
| `dev-setup` | Configure host-wide or per-project local HTTPS development |
| `completion` | Print Bash, Zsh, or Fish completion |

## Provider and feature choices

Config providers: `coolify`, `coolify-github-app`, `ghcr`, `hetzner`, `cloudflare`, `dns`, `cloudflare-workers` (Cloudflare alias), `s3`, `glitchtip`, `plausible`, `listmonk`, `ses`, `search-console`, `stripe`, `modal`, `runpod`, `hf`, `replicate`.

Project services: `glitchtip`, `plausible`, `listmonk-ses`, `s3`, `email`, `search-console`. Resend is no longer offered. Cloudflare handles CLI DNS automation; INWX supports registrar nameserver setup.

`create` accepts partial flags and prompts for missing answers. `--yes` / `--non-interactive` takes defaults or fails on a missing required value. Flags override `--config` JSON.

```bash
hatchkit create --yes --dry-run --name blog --domain blog.example.com \
  --surfaces fullstack --deployment-mode coolify
```

| Flag | Values |
|---|---|
| `--surfaces` | `fullstack` `split` `backend` `static` |
| `--topology` | `single-origin` `split` |
| `--deployment-mode` | `coolify` `gh-pages` `cloudflare` `scaffold-only` |
| `--coolify-runtime` | `image` (new-project default) `compose` |
| `--deploy-target` | `new` `existing`; existing needs server ID/IP in unattended mode |
| `--server-size` | `cpx21` `cpx31` `cpx41` |
| `--server-location` | `nbg1` `fsn1` `hel1` |
| `--features` | `websocket` `stripe` `analytics` `s3` `workspaces` `token-client-auth` `desktop` `mobile` `release` `client-core` `extension` `server-migrations` `scheduler` `public-api` `auth-account-security` `i18n` `raycast` `mcp` |
| `--analytics-providers` | `glitchtip` `plausible` |
| `--services` | `glitchtip` `plausible` `listmonk-ses` `s3` `email` `search-console` |
| `--db-engine` | `mongodb` `postgres` |
| `--db-provider` | `coolify` `external` |
| `--s3-provider` | `hetzner` `r2` `aws` `existing` `none` |
| `--email` | `none` `transactional` `mailing-list` `both`; enabled choices use Listmonk/SES |
| `--ml-services` | `3d-sam-objects` `3d-sam-body` `3d-hunyuan` `3d-trellis` `3d-extraction` `subtitles` `image-recognition` `background-removal` `custom-hf` |
| `--gpu-platforms` | `modal` `runpod` `hf` `replicate`; first sets default `ML_BACKEND` |
| `--github-visibility` | `private` `public`; also `--private` / `--public` |
| `--local-dev[=SLUG]` / `--no-local-dev` | Enable or skip Tailscale/Caddy development URLs |

For the remaining name/domain, storage, forwarding, install, scaffold, GitHub, and deploy flags, read current create help. Prefer a private `--config` file over command-line secrets.

`gh-pages` and `cloudflare` deployment modes require a static surface. Extension/Raycast/MCP require fullstack or split. Raycast and MCP pull in client-core; MCP also needs public-api. Fullstack and split both retain client/server/shared packages.

Create/update also apply operational generators. User-owned files have preservation rules; owned operational files and recognized security templates can be refreshed. Review dry-run output and diffs. `--force` controls changed package entries, not every file.

Modal has an automated ML deployment path. Other platform paths print manual guidance and return placeholders or inferred endpoints. Verify endpoints before configuring the app. Even Modal falls back to an example URL if output parsing fails.

## Static hosting and migration

`cloudflare` means Workers Static Assets. `gh-pages` means GitHub Pages. Hatchkit has no dedicated Cloudflare Pages mode. Resolve an ambiguous “Pages” request before acting.

An assets-only Worker has `assets.directory` and no `main` script. It requires no PHP, container, or Coolify app. Preserve a hybrid project's API: `clientHost: "cloudflare"` differs from static-only `deploymentMode: "cloudflare"`.

Adopt can initialize dotenvx, create a remote, configure providers, and push. Review those choices. A public static archive may not need dotenvx. Confirm its real build command and output directory. New adopted GitHub repos default to private unless explicitly selected otherwise.

Keep operator credentials local. CI receives one Worker's deploy token or one Coolify app's deploy-hook secret. Worker scope does not prove isolation from other same-account runtime bindings. Preserve separate operator routing and routine CI deployment responsibilities.

Use `migrate-client --dry-run` and `--repo-only` before live client cutover. Runtime migrations preserve a legacy app for rollback. Cleanup removes that recovery path; do not treat cleanup as another harmless verification step. A carried volume can have concurrent writers during rolling deploys.

## Backups and host checks

Backup credentials are separate from app asset storage: keychain service `hatchkit`, account `backups:r2:credentials`. Keep an independent recovery copy of the restic password. Never copy backup keys into app env.

With auto-registration enabled, create registers standard managed and Compose database sources on configured backup hosts. Existing/adopted projects and custom sources need explicit coverage. Asset buckets are separate from registered server-data backups.

New policies retain 30 verified generations. Existing policies retain their configured `keepLast` count (3–365). Registration is intent; inspect `backup status` for actual captures and restores. Hosts use Tailscale without public-SSH fallback.

`backup install` preserves sources and refuses a changed recovery password or repository. It does not enable capture scheduling. `backup timer --enable` requires fresh verified captures. `--disable` stops captures and keeps snapshots. Source updates and deregistration require an explicit coverage decision.

`backup restore` retains isolated recovered files/containers. `restore-check` uses disposable containers and does not overwrite production. Weekly native drills have a nine-day freshness limit. A native import does not prove the app starts with recovered data.

`host integrity install` schedules five-minute quick checks and a daily full scan. `host updates install` schedules four-hour advisory/runtime checks and a daily Grype image scan. Installation needs backup-alert SMTP; update-watch also needs a pinned, signature-verified `/usr/local/bin/grype`. Install dry-runs still perform read-only scans.

Update-watch can repeat unchanged overdue findings daily. Check completeness and freshness, not only a zero finding count. AIDE and independent monitoring have maintenance templates, not general CLI install commands. The current health publisher is restricted to the maintained fleet and destination.

## Cloudflare audit, SES, and Apple jobs

The Cloudflare audit uses a separate read-only user token, never the operator token. Required grants and incident steps are in the [operations guide](https://hatchkit.trebeljahr.com/docs/operations#cloudflare-audit-token). Review unknown token IDs before accepting inventory. `test-mail` sends email.

SES project IAM isolation and newsletter-service isolation have separate planning and verification steps. Read subcommand help and the email guide. Do not substitute the operator's SES credential into an app. `listmonk user` and `listmonk list` can mutate shared provider state.

Before private-repo Apple dispatch, run `mac-runner status --repo owner/name`. When `APPLE_RUNNER` is set, use an authorized `mac-runner run` or `serve`; a plain dispatch can wait without a host. Preserve existing signing material and keep temporary credentials scoped to the job.

## Documentation and code

Read the guide relevant to the current operation:

- [Commands](https://hatchkit.trebeljahr.com/docs/commands)
- [Cloudflare hosting and tokens](https://hatchkit.trebeljahr.com/docs/cloudflare)
- [Migrations](https://hatchkit.trebeljahr.com/docs/migrations)
- [Backups and recovery](https://hatchkit.trebeljahr.com/docs/backups)
- [Operations and generated-file ownership](https://hatchkit.trebeljahr.com/docs/operations)
- [Email and SES isolation](https://hatchkit.trebeljahr.com/docs/email)

In this repository, the same pages live under `docs/content/docs/`. CLI routing/help is in `cli/src/index.ts`; state is in `config.ts`, `status.ts`, `doctor.ts`, and `explain.ts`. Scaffold, deployment, provisioning, and backup code live in their corresponding `cli/src/` directories. App templates live in `starter/`, infrastructure in `infra/`, and the operator MCP server in `mcp/`.

The operator MCP server is read-only and inherits keychain denial unless access is explicitly authorized. The generated app MCP server is separate and can mutate app data within its API-token scope. Do not confuse their credentials or authority.

For a failure, capture command, cwd, version, output, safe state checks, suspected source, affected resources, and recovery options. Repair locally within authorization. Any handoff must preserve existing setups and use fake credentials for tests. Record provider/keychain checks that require unavailable access as pending.

The two repository skill copies must remain identical. `cli/test-documentation-contracts.ts` checks synchronization.
