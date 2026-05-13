# Agent Instructions

Before repo work on this machine, read and follow:

```bash
/Users/rico/.agents/AGENTS.md
```

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
- `hatchkit keys show <project> --json` only when the user specifically asks for
  the dotenvx private key.

If `@hatchkit/mcp` is configured, prefer its read-only tools:
`hatchkit_status`, `hatchkit_doctor`, `hatchkit_explain`, and
`hatchkit_keys_show`.

## CLI Guard Rails

- `hatchkit doctor` is safe and read-only.
- `hatchkit create`, `setup`, and `config add` are interactive. Do not run them
  unattended unless the user provided automation flags/config.
- `hatchkit create` can scaffold files, initialize git, create GitHub repos,
  run Terraform, configure DNS, create Coolify apps, and deploy.
- `hatchkit add`, `remove`, `keys push`, `keys rotate`, `gh-pages`, `sync`,
  `rename-domain`, `regen-infra`, `provision s3`, and `destroy` can mutate local
  files and/or remote systems. Make sure the user asked for the action.
- Never print secrets unless the user explicitly requested them.
- `hatchkit config reset` clears provider metadata and keychain entries. Confirm
  before running or recommending it.
- For any command that could affect an existing setup, report first and give the
  user the command to run. Prefer `--dry-run`, `--json`, or `--recipe` modes.
- Know the undo path before executing mutations. `hatchkit destroy <project>
  --recipe` prints rollback commands without running them; `hatchkit gh-pages
  --undo --dry-run` previews Pages cleanup; create/adopt ledgers let
  `hatchkit destroy <project>` undo resources Hatchkit created.
- Ask before running rollback, cleanup, Terraform, DNS, Coolify, keychain, or
  provider API mutations.

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
- `cli/src/provision/`: GlitchTip/OpenPanel/Resend/S3/email/Stripe provisioning.
- `starter/`: scaffold template used by `hatchkit create`.
- `infra/`: Terraform/Coolify automation.
- `services/`: ML service templates.
- `mcp/`: `@hatchkit/mcp` read-only agent server.
- `docs/`: docs site.
