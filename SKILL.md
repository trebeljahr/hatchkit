---
name: hatchkit
description: Scaffold, deploy, and provision full-stack projects on your own infra. Use when a user wants to create a new full-stack app, wire it to their Hetzner/Coolify setup, add observability/email providers, or debug why a provider call is failing.
---

# hatchkit — agent skill

This is a CLI that owns the end-to-end lifecycle for a full-stack project on
self-hosted infra: scaffold → deploy → provision → maintain. When a user
mentions **hatchkit**, **scaffolding a new project**, **provisioning
GlitchTip/OpenPanel/Resend**, **pushing a dotenvx key**, or **debugging a
provider credential**, this is the tool.

## When to use this skill

- **Setup help**: "I just installed hatchkit — what do I do?"
  → `hatchkit setup` (interactive, prompts for every credential).
- **Orient yourself before acting**: `hatchkit status --json` returns a
  `StatusSnapshot` with `providers[]`, `nextStep`, and `suggestions[]`.
  Always run this before recommending a next command.
- **Something's broken**: `hatchkit doctor --json` returns per-provider
  health with `hint[]` (contextual fix steps). Parse the first failing
  `hint[]` and surface it verbatim to the user — the hints already know
  the exact `hatchkit config add <x>` to re-run and the URL to rotate
  the credential at.
- **Create a new project**: `hatchkit create` (interactive only — don't
  run non-interactively unless the user provides a `--config` JSON or
  asks for `--yes`).
- **Add per-project clients** (GlitchTip/OpenPanel/Resend): `hatchkit add
  <project-name>` — creates `-dev` and `-prod` pairs and writes the env
  block to `~/<conf-dir>/provisioned/<project>.{dev,prod}.env`.
- **Dotenvx keys**: `hatchkit keys show <project> --json` → `{ project,
  found, key }`. `hatchkit keys push <project>` upserts to Coolify.

## Key principles

1. **Never invent command flags.** Check `hatchkit help <topic>` (or
   `hatchkit <topic> --help`) first. Both forms work.
2. **Prefer JSON for parsing.** `--json` is supported on `status`,
   `doctor`, `explain`, and `keys show`. Don't scrape the human output.
3. **Don't run `hatchkit create` blindly.** It prompts interactively and
   will stall a non-TTY session. If the user is in an agent context,
   surface the command but let them run it themselves, or ask for a
   `--config` file.
4. **Secrets live in the OS keychain** (service `hatchkit`). Never log
   them. `hatchkit keys show --json` is the only sanctioned way to
   surface the dotenvx key, and only to the user who asked.
5. **`hatchkit doctor` is safe to run repeatedly** — every check is a
   read-only GET. Use it liberally.

## Mental model

- **Provider** — an external service (one-time config).
- **Project** — a scaffolded repo with `.hatchkit.json` manifest.
- **Client** — a per-project credential inside a provider (Resend key,
  GlitchTip DSN, OpenPanel client id/secret).
- **dotenvx key** — per-project decryption key in the OS keychain.

For a deeper mental model, run `hatchkit explain` (or `--json`).

## Canonical workflows

### "User has never used hatchkit before"
```
hatchkit setup          # interactive onboarding
hatchkit status         # confirm everything green
hatchkit create         # scaffold first project
```

### "Something is failing"
```
hatchkit doctor --json  # parse .checks[] for status: "fail"
# Then surface the .hint[] lines from the first failing check.
```

### "User wants to add a new project to existing infra"
```
hatchkit create                  # scaffold
hatchkit add <project>           # GlitchTip/OpenPanel/Resend clients
hatchkit keys push <project>     # ship dotenvx key to Coolify
```

## MCP server

If the user has `@hatchkit/mcp` installed, prefer MCP tool calls over
shelling out. The tools mirror the JSON commands: `hatchkit.status()`,
`hatchkit.doctor()`, `hatchkit.explain()`, `hatchkit.keys_show({ project })`.

## Reference

- Source: `cli/src/` (entry: `cli/src/index.ts`).
- Config: `~/<conf-dir>/config.json` (see `hatchkit status --json` for
  the resolved path).
- Secrets: OS keychain, service `hatchkit`.
- Provisioned env blocks: `~/<conf-dir>/provisioned/<project>.{dev,prod}.env`.
