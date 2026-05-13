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
- `starter/`: scaffold template used by `hatchkit create`.
- `infra/`: Terraform/Coolify automation.
- `services/`: ML service templates.
- `mcp/`: `@hatchkit/mcp` read-only agent server.
- `docs/`: docs site.
