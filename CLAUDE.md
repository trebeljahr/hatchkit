# Hatchkit Agent Memory

This repository is Hatchkit. Hatchkit is a CLI for taking a product from idea to
running app on user-owned infra:

scaffold -> deploy -> provision -> maintain.

Use the `.claude/skills/hatchkit` skill whenever the user mentions Hatchkit, the
CLI, scaffolding a new app, Coolify/Hetzner/DNS/R2/Resend, dotenvx keys, provider
credentials, GitHub Pages wiring, repo adoption, or project provisioning.

## First Step

Before recommending Hatchkit commands, run:

```bash
hatchkit status --json
```

Read `providers[]`, `nextStep`, and `suggestions[]`. Do not guess the user's
current setup.

If `@hatchkit/mcp` is available, prefer the read-only MCP tools:
`hatchkit_status`, `hatchkit_doctor`, `hatchkit_explain`, and
`hatchkit_keys_show`.

## Safe Diagnosis

For failures:

```bash
hatchkit doctor --json
```

Report the failing `checks[].hint[]` lines. They contain the exact credential
rotation URL, scopes, and `hatchkit config add <provider>` command.

## Command Shape

- `hatchkit setup` / `init`: interactive credential onboarding.
- `hatchkit create`: interactive scaffold/deploy flow.
- `hatchkit update`: add supported features to an existing project (`desktop`, `mobile`, `release`, `auth-account-security`, `client-core`).
- `hatchkit add <project> [services]`: provision GlitchTip/OpenPanel/Resend/S3/email.
- `hatchkit keys show|push|rotate <project>`: manage dotenvx private keys.
- `hatchkit gh-pages`: configure GitHub Pages for the current repo.
- `hatchkit adopt`: bring an existing repo under Hatchkit conventions.
- `hatchkit sync`, `rename-domain`, `regen-infra`, `provision s3`: maintain deployed projects. `sync` pushes the manifest's `domain` + `aliases[]` (multi-hostname) onto Coolify.
- `hatchkit dns publish [--dry-run]`: upsert Cloudflare A/AAAA records for the manifest's domain + aliases, pointing at the Coolify server.
- `hatchkit plausible rename <old> <new>`: move a Plausible site to a new domain (stats history preserved).
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
- `cli/src/features/auth-account-security/`: opt-in account-security feature
  (two-factor, account controls, extra sign-in methods). Additive via
  `hatchkit update`. `plugin-order.ts` holds the one rule that fails
  silently — `bearer()` must be registered after every plugin that can
  replace the session — and `cli/test-auth-account-security.ts` pins it by
  reading the GENERATED `auth.ts`.
- `cli/src/features/client-core/`: opt-in host-free client kit (offline queue,
  sync client, client/server version handshake). Additive via `hatchkit update`.
  `markers.ts` holds the convention that keeps the create-time strip from
  drifting, and `cli/test-client-core.ts` pins it by round-tripping the starter.
- `cli/src/deploy/`: Coolify, Terraform, GitHub, keys, pages, rollback.
- `cli/src/features/`: opt-in features. `signing/` provisions release
  signing; `server-platform/` + `server-migrations/`, `scheduler/`,
  `public-api/` write server infrastructure into an already-scaffolded
  project. These are ADDITIVE — nothing of theirs ships in `starter/`, so
  `create` and `update` run the same writer and re-running is a no-op.
  Their file bodies live in `cli/src/templates/features/<id>/` as `.tpl`
  (a `.ts` there would be typechecked by the CLI's own tsconfig).
- `cli/src/provision/`: provider/client provisioning.
- `starter/`: scaffold template.
- `infra/`: Terraform/Coolify automation.
- `services/`: ML templates.
- `mcp/src/index.ts`: read-only MCP server.
- `docs/content/docs/`: docs source.
