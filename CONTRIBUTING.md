# Contributing

Thanks for helping improve Hatchkit. This repo is a TypeScript monorepo for the `hatchkit` CLI, docs site, starter template, infra templates, and MCP server.

## Local Setup

```bash
pnpm install
pnpm --filter hatchkit run dev
```

Useful checks:

```bash
pnpm --filter hatchkit run typecheck
pnpm --filter hatchkit run check
```

Docs:

```bash
pnpm -C docs run dev
pnpm -C docs run typecheck
```

MCP server:

```bash
pnpm -C mcp run typecheck
```

## Development Notes

- Keep changes scoped to the CLI, docs, starter, infra, or MCP area you are editing.
- Prefer JSON command surfaces when testing agent-facing behavior: `hatchkit status --json`, `hatchkit doctor --json`, `hatchkit explain --json`.
- Do not commit secrets. Provider tokens belong in the OS keychain, and dotenvx private keys must never be printed or checked in.
- Use `HATCHKIT_CONF_DIR` for isolated test state when exercising provider config or generated project state.
- Prefer dry-run, recipe, or local-only flows before running commands that can mutate GitHub, DNS, Coolify, Terraform, keychain, or provider state.

## Pull Requests

Please include:

- What changed and why.
- Validation commands run.
- Any provider, deployment, migration, or rollback risk.
- Screenshots or terminal output for user-facing docs/CLI changes when helpful.

## Release Notes

User-visible changes should add or update an entry in `CHANGELOG.md`.

## Releasing

Maintainers release from a clean `main`:

```bash
pnpm release
```

`pnpm release` makes a patch release; `release:minor` and `release:major` work the same way. The script bumps every package, commits, tags, builds, publishes the four npm packages, and then pushes the commit and the tag. With 2FA on the npm account, npm asks for authentication in the terminal for each publish.

Nothing is pushed until every package is on npm. If a step fails, fix the cause and run `pnpm release:resume`. It skips the packages already on npm.
