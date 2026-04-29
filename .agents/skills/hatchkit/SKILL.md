---
name: hatchkit
description: Use when the user asks about the hatchkit CLI — scaffolding full-stack projects, configuring providers (Coolify/Hetzner/DNS/GlitchTip/OpenPanel/Resend), running `hatchkit doctor`, pushing dotenvx keys, or debugging why a provider call is failing. Start by running `hatchkit status --json` to orient before recommending commands.
---

# hatchkit

`hatchkit` is a CLI in this monorepo (`cli/`) that owns project lifecycle
on self-hosted infra: scaffold → deploy → provision → maintain.

## First principle: orient before acting

Before recommending any command, run:

```bash
hatchkit status --json
```

Parse `providers[]`, `nextStep`, and `suggestions[]`. These reflect the
user's *current* state — don't guess.

## Second principle: read the hints

When something fails, run `hatchkit doctor --json` and surface the
`checks[].hint[]` lines for failing providers. They already contain the
exact URL to rotate the credential, the required permission scopes, and
the `hatchkit config add <provider>` to re-run. Don't paraphrase.

## Commands at a glance

| Command | Purpose | JSON? |
|---|---|---|
| `hatchkit setup` | One-time onboarding — all credentials | — |
| `hatchkit status` | What's configured, what's next | ✓ `--json` |
| `hatchkit doctor` | Live-verify every provider | ✓ `--json` |
| `hatchkit explain` | Mental model of the CLI | ✓ `--json` |
| `hatchkit create` | Scaffold a new project (interactive) | — |
| `hatchkit update` | Add features to an existing scaffold | — |
| `hatchkit add <p>` | Provision GlitchTip/OpenPanel/Resend clients | — |
| `hatchkit keys show <p>` | Print the project's dotenvx private key | ✓ `--json` |
| `hatchkit keys push <p>` | Upsert the key onto Coolify | — |
| `hatchkit config add <x>` | Configure one provider | — |

Provider names for `config add`: `coolify`, `hetzner`, `dns`, `s3`,
`modal`, `runpod`, `hf`, `replicate`, `glitchtip`, `openpanel`, `resend`.

## Guard rails

- `hatchkit create` is **interactive**. Don't run it non-interactively
  for the user — surface the command instead. For automation, it
  accepts `--yes --config <path.json>` but that's advanced.
- **Never log secrets.** `hatchkit keys show` goes to the user; don't
  pipe it into tool output that might land in a transcript.
- **`config reset` nukes everything** (providers + keychain + ML
  registry + ports). Always confirm before suggesting it.

## When the user says…

- "I'm new to hatchkit" → tell them to run `hatchkit explain`, then
  `hatchkit setup`.
- "It's not working" → run `hatchkit doctor --json`, relay the first
  failing check's hints verbatim.
- "What's configured?" → `hatchkit status --json`.
- "Create a project" → let them run `hatchkit create`; don't run it.
- "Rotate my Cloudflare/Hetzner/Resend/… token" → the `config add <x>`
  flow replaces the stored credential in the keychain.

## MCP

If `@hatchkit/mcp` is configured in the user's MCP settings, use the
tool calls directly:
- `hatchkit.status()` → `StatusSnapshot`
- `hatchkit.doctor()` → `{ summary, checks[] }`
- `hatchkit.explain()` → `ExplainModel`
- `hatchkit.keys_show({ project })` → `{ project, found, key }`
