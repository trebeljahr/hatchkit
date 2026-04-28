# hatchkit

> Interactive CLI for scaffolding full-stack projects with composable ML services — from `npx hatchkit` to a deployed app on your own infrastructure in minutes.

[![npm](https://img.shields.io/npm/v/hatchkit.svg)](https://www.npmjs.com/package/hatchkit)
[![CI](https://github.com/trebeljahr/hatchkit/actions/workflows/ci.yml/badge.svg)](https://github.com/trebeljahr/hatchkit/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

---

## What is hatchkit?

Hatchkit turns the messy 2-week ritual of *"start a new product"* into a single guided command. It:

- **Scaffolds** a production-ready full-stack TypeScript app from a batteries-included starter (websockets, Stripe, analytics, S3, native desktop/mobile, auth — pick what you need).
- **Provisions** observability, email, and analytics clients (GlitchTip, OpenPanel, Resend) paired per environment.
- **Deploys** DNS, a VPS, and a Coolify app via Terraform — or pushes to an existing server you already own.
- **Ships ML** by deploying pre-built GPU services (subtitles, image recognition, background removal, 3D extraction) to Modal, RunPod, Hugging Face, or Replicate.
- **Encrypts secrets** with dotenvx and keeps private keys in the OS keychain — never in git.

No vendor lock-in. Everything it spins up — your server, your Coolify, your GitHub repo, your DNS — stays yours.

---

## Quickstart

```bash
# One-time: wire up credentials (GitHub, Coolify, Hetzner, DNS, …)
npx hatchkit setup

# See what's configured and what's next
npx hatchkit status

# Scaffold + deploy a new project
npx hatchkit create
```

That's it. You'll be walked through name → domain → features → ML → deploy target, then hatchkit will scaffold, commit, create the GitHub repo, provision DNS + server, and push the app to Coolify.

New to the CLI? Run `hatchkit explain` for a one-page mental model covering every concept, command, and the canonical workflow.

---

## Commands at a glance

| Command | What it does |
|---|---|
| `hatchkit setup` | One-time onboarding — stores tokens in the OS keychain. Alias: `init`. |
| `hatchkit status` | Show which providers are configured and what's the next best step. |
| `hatchkit doctor` | Health-check every configured provider with a read-only API call + contextual fix hints on failures. |
| `hatchkit explain` | Print the one-page mental model (concepts, commands, workflow). |
| `hatchkit create` | Scaffold a new project (interactive) and optionally deploy it end-to-end. |
| `hatchkit update` | Add features (desktop, mobile, …) to a project already scaffolded. |
| `hatchkit add <project> [services]` | Provision `-dev` / `-prod` GlitchTip / OpenPanel / Resend clients. |
| `hatchkit gh-pages` | Wire GitHub Pages for the current repo (static / Vite / Jekyll) with optional custom domain + DNS. |
| `hatchkit keys show/push <project>` | Read or push the dotenvx private key to Coolify. |
| `hatchkit config [add/reset]` | Inspect or modify stored provider credentials. |
| `hatchkit completion <shell>` | Print a zsh / bash / fish completion script. |

Full reference: **[docs/commands.md](docs/commands.md)**, or `hatchkit help <command>`.

---

## What gets set up

```
           ┌──────────────────────────────────────────────┐
           │              hatchkit create                  │
           └──────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
 ┌─────────────┐         ┌─────────────┐          ┌─────────────┐
 │  Scaffold   │         │   Infra     │          │     ML      │
 │             │         │             │          │             │
 │  starter →  │         │ Terraform → │          │  Modal /    │
 │  your repo  │         │ DNS + VPS   │          │  RunPod /   │
 │  + GitHub   │         │ + Coolify   │          │  HF / …     │
 └─────────────┘         └─────────────┘          └─────────────┘
        │                       │                        │
        └───────────────────────┼────────────────────────┘
                                ▼
                     https://your-domain.example
```

See **[docs/architecture.md](docs/architecture.md)** for the deeper tour.

---

## For agents

Agents (Claude Code, Cursor, Claude Desktop) can drive hatchkit without scraping CLI output:

- `hatchkit status --json` → `StatusSnapshot` (providers, `nextStep`, suggested commands).
- `hatchkit doctor --json` → per-provider health with a `hint[]` array on failing checks (credential rotation URL, required scopes, the exact `hatchkit config add <x>` to re-run).
- `hatchkit explain --json` → full mental model (concepts, commands, workflows, state locations).
- `hatchkit keys show <project> --json` → `{ project, found, key }`.

`SKILL.md` at the repo root (and `.claude/skills/hatchkit/SKILL.md` for Claude Code) tells agents when and how to reach for hatchkit.

An MCP server (`@hatchkit/mcp`) exposes the JSON commands as MCP tools. See **[mcp/README.md](mcp/README.md)**.

---

## Shell completion

```bash
hatchkit completion zsh  > ~/.zsh/completions/_hatchkit
hatchkit completion bash > /usr/local/etc/bash_completion.d/hatchkit
hatchkit completion fish > ~/.config/fish/completions/hatchkit.fish
```

---

## State — where things live

| What | Where |
|---|---|
| Provider metadata (no secrets) | `~/<conf-dir>/config.json` |
| Secrets (tokens, keys) | OS keychain, service `hatchkit` |
| Provisioned env blocks | `~/<conf-dir>/provisioned/<project>.{dev,prod}.env` |
| Project manifest | `<project>/.hatchkit.json` |

`HATCHKIT_CONF_DIR` overrides the config directory.

---

## Documentation

Full docs live under [`docs/`](docs/) and are published to **GitHub Pages** at [https://trebeljahr.github.io/hatchkit/](https://trebeljahr.github.io/hatchkit/).

- [Getting Started](docs/getting-started.md) — install, onboard, create your first project
- [Commands reference](docs/commands.md) — every command + every flag
- [Providers](docs/providers.md) — GitHub, Coolify, Hetzner, DNS, S3, GPU platforms
- [ML services](docs/ml-services.md) — deploy GPU-backed models the CLI understands
- [GitHub Pages](docs/gh-pages.md) — `hatchkit gh-pages` for static sites, SPAs, sprite tools, Jekyll docs
- [Architecture](docs/architecture.md) — how scaffold / infra / deploy fit together
- [Deploying the docs site](docs/deployment.md) — the GitHub Pages flow used by this repo

---

## Repo layout

```
hatchkit/
├─ cli/              # the npm package (published as `hatchkit`)
├─ mcp/              # @hatchkit/mcp — MCP server for agents
├─ starter/          # full-stack starter template (subtree-merged)
├─ infra/            # Terraform + Coolify automation (subtree-merged)
├─ services/ml/      # pre-built ML service templates
│  ├─ image-recognition/
│  ├─ subtitles/
│  ├─ 3d-extraction/
│  └─ background-removal/
├─ docs/             # Jekyll docs site — deployed to GitHub Pages
└─ .github/workflows/
   ├─ ci.yml         # typecheck + lint + scaffold matrix
   ├─ gitleaks.yml   # secret scanning
   └─ docs.yml       # GitHub Pages deploy
```

---

## Development

```bash
# Install deps (monorepo)
pnpm install

# Run the CLI against the local source (tsx)
pnpm --filter hatchkit dev

# Typecheck + lint + scaffold test matrix
pnpm --filter hatchkit check

# Install locally as a global command
pnpm --filter hatchkit install-local
```

Clone the repo and you're set — `starter/` and `infra/` are in-tree
(previously git submodules; merged via `git subtree`).

```bash
git clone https://github.com/trebeljahr/hatchkit.git
```

---

## License

MIT — see [LICENSE](LICENSE).
