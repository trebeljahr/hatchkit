# Agent Instructions

If the operator maintains a machine-level agent file (e.g.
`~/.agents/AGENTS.md` or `~/.claude/CLAUDE.md`), read and follow it
first; the rules below are repo-specific and stack on top of any
machine-level conventions.

## Hatchkit Context

This repository is Hatchkit. Hatchkit is a CLI for scaffolding, deploying,
provisioning, and maintaining full-stack TypeScript apps on user-owned infra.

When the user says "hatchkit", "the CLI", "scaffold a project", "deploy this",
"wire Coolify/Hetzner/DNS/R2/Resend", "push the dotenvx key", or "provider setup
is failing", use Hatchkit context.

Before recommending a Hatchkit command, orient with:

```bash
hatchkit status --json
```

Use JSON surfaces when possible:

- `hatchkit status --json` for provider state and next step.
- `hatchkit doctor --json` for read-only provider health and fix hints.
- `hatchkit explain --json` for concepts, commands, workflows, and state.
- `hatchkit overview --json` for project state.
- `hatchkit map --json` for the whole fleet: places, connections, projects,
  jobs and which pieces hatchkit lists, set up, or never touched.
- `hatchkit keys show <project> --json` only when the user specifically asks for
  the dotenvx private key.

If `@hatchkit/mcp` is configured, prefer its read-only tools:
`hatchkit_status`, `hatchkit_doctor`, `hatchkit_explain`, and
`hatchkit_keys_show`.

## CLI Guard Rails

### Static hosting names

| User's target | Hatchkit mode / command | Hosting product |
|---|---|---|
| Cloudflare static site | `cloudflare` / `hatchkit cloudflare` | Workers Static Assets |
| GitHub Pages | `gh-pages` / `hatchkit gh-pages` | GitHub Pages |
| Cloudflare Pages | No dedicated Hatchkit mode | Separate Cloudflare product |

If the user says only “Pages”, resolve the provider from context before acting.
Do not interpret `gh-pages` as Cloudflare Pages. Earlier Cloudflare migrations
may use Workers Static Assets even when described informally as static pages.
An assets-only Worker has an `assets.directory` and no `main` script. It needs
no PHP, container, Coolify app, or application server.

Read [the hosting comparison](docs/content/docs/cloudflare.mdx#choose-the-hosting-product)
and inspect the project's manifest, Wrangler config, and workflow. A hybrid
app's `clientHost: "cloudflare"` differs from a static-only project's
`deploymentMode: "cloudflare"`; preserve any existing API deployment.

`hatchkit adopt` is interactive and can bootstrap dotenvx, create a remote,
wire Coolify, set deployment credentials, and push. Review those rows before
applying. A public static archive usually needs no dotenvx bootstrap. Verify
its actual build command and output directory before accepting generated CI.
`hatchkit cloudflare` also creates a Worker and publishes deployment secrets;
it is not a read-only planning command. A blank custom domain keeps setup on
`workers.dev` for validation before a live domain migration. Keep the local
operator credential out of CI; use the per-Worker deployment token.

- `hatchkit doctor` is safe and read-only. `hatchkit doctor --fix` writes to
  providers; ask before running it.
- `hatchkit create`, `setup`, and `config add` are interactive. Do not run them
  unattended unless the user provided automation flags/config.
- `hatchkit create` can scaffold files, initialize git, create GitHub repos,
  run Terraform, configure DNS, create Coolify apps, and deploy.
- `hatchkit add`, `remove`, `keys push`, `keys rotate`, `secrets rotate`,
  `gh-pages`, `cloudflare`, `sync`,
  `rename-domain`, `regen-infra`, `provision s3`, and `destroy` can mutate local
  files and/or remote systems. Make sure the user asked for the action.
- Never print secrets unless the user explicitly requested them.
- `hatchkit config reset` clears provider metadata and keychain entries. Confirm
  before running or recommending it.
- For any command that could affect an existing setup, report first and give the
  user the command to run. Prefer `--dry-run`, `--json`, or `--recipe` modes.
- Know the undo path before executing mutations. `hatchkit destroy <project>
  --recipe` prints rollback commands without running them; `hatchkit gh-pages
  --undo --dry-run` previews Pages cleanup; `hatchkit cloudflare --undo
  --dry-run` previews the Workers cleanup; create/adopt ledgers let
  `hatchkit destroy <project>` undo resources Hatchkit created.
- Ask before running rollback, cleanup, Terraform, DNS, Coolify, keychain, or
  provider API mutations.

## Public repository: no operator data

Hatchkit is public. Commit generic tooling only. Never commit one operator's
fleet: host names, tailnet names or addresses, public IPs, Coolify resource
UUIDs, Worker URLs, mail addresses, per-app rollout notes, or run scripts and
evidence written for specific hosts. Keep those out of this repo: delete
one-off run scripts after the run, and keep records in the operator's private
notes. Tests and docs use made-up names (`app-vps`, `ops-vps`,
`example.com`, `203.0.113.0/24`, `100.64.0.0/10`).

The pre-push hook refuses a push that adds `infra/maintenance/`, or whose added
lines contain a fixed string from `~/.config/hatchkit/fleet-denylist` (or the
file named by `$HATCHKIT_FLEET_DENYLIST`). The denylist lives outside the repo,
so the repo never names what it guards against.

## Break/Fix Workflow

If Hatchkit is breaking, agents should report the issue and can write a repair
prompt for another agent or a follow-up session.

Capture:

- Failing command, cwd, Hatchkit version, and output.
- Safe state checks: `hatchkit status --json`, `hatchkit doctor --json`, and
  relevant `hatchkit help <command>`.
- Suspected source files, expected behavior, risk/blast radius, rollback path,
  and validation commands.

Repair prompts must say: preserve existing user setups, use dry-run or isolated
`HATCHKIT_CONF_DIR` where possible, do not touch real provider/DNS/Coolify/
Terraform/keychain state without user approval.

## Useful Repo Commands

### Keychain access during development

- Run CLI tests through `pnpm --filter hatchkit test` or
  `pnpm --filter hatchkit exec node scripts/test.mjs test-<name>.ts`.
  The runner replaces keytar with a temporary fixture store in the test and
  its child processes. `HATCHKIT_CONF_DIR` and `HATCHKIT_KEYTAR_SERVICE` alone
  do not isolate the OS keychain. Do not run tests against real credentials.
- Unattended CLI commands refuse OS keychain access by default. Keep
  `HATCHKIT_KEYCHAIN_ACCESS=deny` during agent work. Live credential access
  needs an intentional interactive run or explicit `HATCHKIT_KEYCHAIN_ACCESS=allow`.
  Do not enable it just to get a check to pass or bypass a denied read with
  `/usr/bin/security`. After a denial, stop; do not retry across runtimes.
- Do not weaken item ACLs, use “allow all applications”, unlock/reset a keychain,
  or export credentials to stop prompts. Report live checks as pending.

```bash
pnpm install
pnpm --filter hatchkit run dev
pnpm --filter hatchkit run typecheck
pnpm --filter hatchkit run check
pnpm --filter hatchkit install-local
```

Source layout:

- `cli/`: published `hatchkit` CLI.
- `cli/src/index.ts`: command router and help text.
- `cli/src/config.ts`: provider config and keychain metadata.
- `cli/src/status.ts`: `hatchkit status --json`.
- `cli/src/doctor.ts`: provider health checks and fix hints.
- `cli/src/explain.ts`: mental model output.
- `cli/src/scaffold/`: project scaffolding.
- `cli/src/deploy/`: Coolify, Terraform, GitHub, keys, pages, rollback.
- `cli/src/provision/`: GlitchTip/Plausible/Resend/S3/email/Stripe provisioning.
- `starter/`: scaffold template used by `hatchkit create`.
- `infra/`: Terraform/Coolify automation.
- `services/`: ML service templates.
- `mcp/`: `@hatchkit/mcp` read-only agent server.
- `docs/`: docs site.
