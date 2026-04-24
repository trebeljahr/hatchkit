---
title: Commands
nav_order: 3
---

# Commands reference

Every hatchkit command supports `--help` for detail. Global flags:

| Flag | Effect |
|---|---|
| `--version`, `-v` | Print the CLI version and exit. |
| `--help`, `-h` | Show help. Pass it to a subcommand for topic-specific help. |

Environment:

| Variable | Effect |
|---|---|
| `HATCHKIT_CONF_DIR` | Override the config + ports registry location. Useful for isolated workspaces and CI. |

---

## `hatchkit setup` (alias: `init`)

One-time onboarding. Walks through every provider hatchkit knows about:

- GitHub (via `gh` CLI)
- Coolify (URL + token)
- Hetzner Cloud, DNS provider (INWX / Cloudflare), S3 (Hetzner / AWS / R2)
- GlitchTip, OpenPanel, Resend
- GPU platforms — Modal, RunPod, Hugging Face, Replicate

Everything is optional; you'll be prompted again the first time a command actually needs that provider.

---

## `hatchkit create`

Scaffold a new project.

```bash
hatchkit create [options]
```

### Options

| Flag | Effect |
|---|---|
| `--dry-run` | Show the plan without writing anything. |
| `--yes`, `-y` | Skip prompts; use defaults + `--config` values. Non-interactive. |
| `--config <path>` | Load a JSON file with `ProjectConfig` overrides. |
| `--name <name>` | Set the project name without prompting. |
| `--no-github` | Skip GitHub repo creation. |
| `--no-deploy` | Skip Terraform / Coolify / ML deployment. |

### Flow

1. Prompts for name, domain, deploy target, features, ML services.
2. Scaffolds the starter, strips unselected features, assigns unique ports.
3. Installs deps (if `pnpm` is available and you opt in).
4. `git init` + first commit + GitHub repo.
5. Generates Terraform tfvars + Coolify `.env`.
6. Runs Terraform (DNS + optionally server).
7. Runs Coolify app setup and pushes the dotenvx private key.
8. Deploys ML services and prints env endpoints to set.

---

## `hatchkit update`

Run **inside an already-scaffolded project** to add features additively.

```bash
cd my-app
hatchkit update
```

Reads `.hatchkit.json`, lets you pick a new feature set, copies additive pieces from the starter. **Supported additions today:** `desktop`, `mobile`. Removal is not supported — removing a feature could delete user code. Remove manually and update the manifest.

---

## `hatchkit add`

Provision observability / email clients for an **existing** project. Creates a `-dev` and a `-prod` client for each selected service.

```bash
hatchkit add                                     # fully interactive
hatchkit add raptor-runner                       # prompts for services
hatchkit add raptor-runner all                   # all services
hatchkit add raptor-runner glitchtip,resend      # explicit list
```

### Services

| Name | Creates | Returns |
|---|---|---|
| `glitchtip` | GlitchTip project | `GLITCHTIP_DSN` |
| `openpanel` | OpenPanel client | `OPENPANEL_CLIENT_ID`, `OPENPANEL_CLIENT_SECRET` |
| `resend` | Restricted Resend API key | `RESEND_API_KEY` |

The resulting env blocks are printed **and** saved under `<config-dir>/provisioned/<project>.{dev,prod}.env` for safe keeping.

---

## `hatchkit pages`

Wire GitHub Pages for the **current repo**. Run it from inside any repo — a sprite tool, a landing page, a docs folder — and it'll detect what's there, enable Pages, write the deploy workflow, and (optionally) configure a custom domain end-to-end.

```bash
cd my-sprite-tool
hatchkit pages
```

### What it detects

| Kind | Trigger | Workflow generated |
|---|---|---|
| `static` | `index.html` at the repo root, no `build` script | checkout → `upload-pages-artifact` → `deploy-pages` |
| `node-build` | `package.json` with a `build` script (pnpm / npm / yarn / bun auto-detected from lockfile) | install → build → upload build output → deploy |
| `jekyll` | `Gemfile` + `_config.yml` at the root **or** under `docs/` | Ruby + `bundle exec jekyll build` → upload `_site` → deploy |

For `node-build`, the publish dir is guessed from the build command (`vite` → `dist`, `react-scripts` → `build`, `astro` → `dist`, `next` → `out`) and you confirm interactively.

### Custom domain

If you opt in:

1. Calls `PUT /repos/:owner/:repo/pages -f cname=<domain>` to register it with Pages.
2. Writes a `CNAME` file into the published folder (or `public/` for node builds).
3. Wires DNS at your provider:
   - **Cloudflare** — uses the token in your keychain; creates/updates `A` records (apex) or a `CNAME` (subdomain) to `<user>.github.io`. Idempotent.
   - **INWX / manual** — prints the records you need to add yourself.

### Good fits

- Sprite editors, palette tools, one-off demos (plain `index.html`).
- Vite / Astro / CRA static sites (client-side only).
- Jekyll or other SSGs whose output is pure HTML.
- A `docs/` folder inside a larger monorepo (like this one).

### Not a good fit

- Anything that needs a running server (websockets, MongoDB, auth sessions, server-rendered Next). Use `hatchkit create` with the full-stack flow for those.

---

## `hatchkit doctor`

Runs a read-only API call against every configured provider — Coolify `/version`, Hetzner `/servers`, Cloudflare `/tokens/verify`, Resend `/domains`, and so on. Reports `ok` / `fail` / `not configured` per provider and exits non-zero if anything fails. Safe to run repeatedly.

---

## `hatchkit keys`

Manage per-project dotenvx private keys.

```bash
hatchkit keys show <project>   # print DOTENV_PRIVATE_KEY_PRODUCTION from keychain
hatchkit keys push <project>   # upsert the key onto the project's Coolify app
```

Keys are generated at scaffold time, live in macOS Keychain / libsecret under the `hatchkit` service, and are **never** written to git.

---

## `hatchkit config`

Inspect or modify stored provider config.

```bash
hatchkit config                      # show provider status
hatchkit config add <provider>       # (re-)configure a provider
hatchkit config reset                # clear ALL CLI config (confirmed)
```

Valid providers: `coolify`, `hetzner`, `dns`, `s3`, `glitchtip`, `openpanel`, `resend`, `modal`, `runpod`, `hf`, `replicate`.
