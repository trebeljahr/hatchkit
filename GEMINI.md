# Hatchkit Agent Memory

This repository is Hatchkit. Hatchkit is a CLI for taking a product from idea to
running app on user-owned infra:

scaffold -> deploy -> provision -> maintain.

When the user says "hatchkit", "the CLI", "scaffold a project", "deploy this",
"wire Coolify/Hetzner/DNS/R2/Resend", "push the dotenvx key", "provider setup is
failing", "GitHub Pages", or "adopt this repo", use Hatchkit context.

## First Step

Before recommending Hatchkit commands, run:

```bash
hatchkit status --json
```

Read `providers[]`, `nextStep`, and `suggestions[]`. These reflect the user's
current machine state.

If `@hatchkit/mcp` is available, prefer the read-only tools:
`hatchkit_status`, `hatchkit_doctor`, `hatchkit_explain`, and
`hatchkit_keys_show`.

## Diagnosis

For failures:

```bash
hatchkit doctor --json
```

Report the failing `checks[].hint[]` lines. They contain the exact credential
rotation URL, scopes, and `hatchkit config add <provider>` command.

## Common Commands

- `hatchkit setup` / `init`: interactive credential onboarding.
- `hatchkit create`: interactive scaffold/deploy flow.
- `hatchkit update`: add supported features to an existing project.
- `hatchkit add <project> [services]`: provision GlitchTip/OpenPanel/Resend/S3/email.
- `hatchkit keys show|push|rotate <project>`: manage dotenvx private keys.
- `hatchkit gh-pages`: configure GitHub Pages for the current repo.
- `hatchkit adopt`: bring an existing repo under Hatchkit conventions.
- `hatchkit sync`, `rename-domain`, `regen-infra`, `provision s3`: maintain deployed projects.
- `hatchkit explain --json`: source-of-truth mental model.

Check `hatchkit help <command>` before using flags you have not verified.

## Safety

- `hatchkit doctor` is read-only.
- Do not run interactive commands unattended unless the user gave automation
  flags/config.
- Mutating commands can touch local files, GitHub, DNS, Terraform, Coolify, and
  provider APIs. Make sure the user asked for that action.
- Never print secrets unless specifically requested.
- Treat `hatchkit config reset` as destructive.
- For commands that could break an existing setup, report first and give the
  command to the user. Prefer `--dry-run`, `--json`, or `--recipe`.
- Know the undo path before executing mutations. `hatchkit destroy <project>
  --recipe` prints rollback commands without executing; `hatchkit gh-pages
  --undo --dry-run` previews Pages cleanup; create/adopt ledgers let
  `hatchkit destroy <project>` undo resources Hatchkit created.
- Ask before running rollback, cleanup, Terraform, DNS, Coolify, keychain, or
  provider API mutations.

## Break/Fix Workflow

If Hatchkit is breaking, diagnose and report first. Then, if useful, write a
repair prompt for another agent or a follow-up session.

Include in the repair prompt:

- Failing command, cwd, Hatchkit version, and output.
- Safe checks run: `hatchkit status --json`, `hatchkit doctor --json`, and
  relevant `hatchkit help <command>`.
- Suspected files, expected behavior, risk/blast radius, rollback path, and
  validation commands.
- Safety instruction: preserve existing user setups, use dry-run or isolated
  `HATCHKIT_CONF_DIR` where possible, and ask before provider/DNS/Coolify/
  Terraform/keychain mutations.

## Development

```bash
pnpm install
pnpm --filter hatchkit run dev
pnpm --filter hatchkit run typecheck
pnpm --filter hatchkit run check
pnpm --filter hatchkit install-local
```

Key paths:

- `cli/src/index.ts`: command router and help text.
- `cli/src/config.ts`: provider config and keychain metadata.
- `cli/src/status.ts`: status JSON.
- `cli/src/doctor.ts`: health checks and hints.
- `cli/src/explain.ts`: mental model.
- `cli/src/scaffold/`: scaffolding.
- `cli/src/deploy/`: Coolify, Terraform, GitHub, keys, pages, rollback.
- `cli/src/provision/`: provider/client provisioning.
- `starter/`: scaffold template.
- `infra/`: Terraform/Coolify automation.
- `services/`: ML templates.
- `mcp/src/index.ts`: read-only MCP server.
- `docs/content/docs/`: docs source.
