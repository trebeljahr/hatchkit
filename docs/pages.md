---
title: GitHub Pages (hatchkit pages)
nav_order: 6
---

# `hatchkit pages`

Wire a GitHub Pages deployment for the **current repo** — including custom domain + DNS — in one command.

Built for the kind of project where `hatchkit create` is overkill: a sprite editor, a color-picker demo, a landing page, a palette tool, a SPA that talks to someone else's API, a `docs/` folder that you want live on the web.

## TL;DR

```bash
cd my-sprite-tool
hatchkit pages
```

That's it. Hatchkit will:

1. Look up the repo via `gh repo view`.
2. Detect whether this is a plain static site, a node build, or a Jekyll site.
3. Ask whether you want a custom domain.
4. Enable Pages via the GitHub API.
5. Write `.github/workflows/pages.yml`.
6. If you asked for a custom domain: set the Pages CNAME, write a `CNAME` file, and wire your DNS provider (Cloudflare automatic; INWX / manual prints the records).

Commit the new workflow + CNAME, push, done.

## What it detects

| Kind | Trigger | What the workflow does |
|---|---|---|
| **static** | `index.html` at repo root, no `build` script | Checks out, uploads the repo root (or a folder you choose), deploys. |
| **node-build** | `package.json` has a `build` script | Sets up your detected package manager (pnpm / npm / yarn / bun from the lockfile), installs, builds, uploads the build output (`dist` / `build` / `out` / …), deploys. |
| **jekyll** | `Gemfile` + `_config.yml` at the root **or** under `docs/` | Sets up Ruby + bundler, `bundle exec jekyll build` with the correct `baseurl`, uploads `_site`, deploys. |

For `node-build`, the publish dir is guessed from the build command and you get to confirm / change it before anything is written.

## Custom domain

When you say yes:

1. **Pages side:** `PUT /repos/:owner/:repo/pages -f cname=<domain>` — this is what makes GitHub serve the site at your domain and provision a cert.
2. **CNAME file:** written into the *published* folder:
   - Jekyll → the source dir (Jekyll copies it into `_site`).
   - Static → repo root.
   - Node build → `public/` if it exists (Vite/CRA/Astro all copy that verbatim into the build). Otherwise repo root with a warning to wire it into your build.
3. **DNS:**
   - **Cloudflare** — uses the token in your keychain to create the right records automatically. Apex domain → 4 × `A` to GitHub's Pages IPs. Subdomain → `CNAME` to `<your-user>.github.io`. Re-running is idempotent.
   - **INWX / manual** — prints the exact records you need to add yourself.
   - **Not configured** — prompts you to configure one (same flow as `hatchkit config add dns`) or falls back to printing manual records.

## Sprite-tool-size projects

Exactly the use case this command was built for:

```bash
mkdir sprite-tool && cd sprite-tool
git init && gh repo create sprite-tool --public --source=.
echo "<h1>Sprite tool</h1>" > index.html
git add -A && git commit -m "init"
hatchkit pages              # → https://<user>.github.io/sprite-tool/
```

With a custom domain:

```bash
hatchkit pages
# Custom domain? Yes
# Domain: sprites.example.com
# (Cloudflare configured → CNAME created automatically)
git add -A && git commit -m "ci: pages" && git push
# → https://sprites.example.com
```

## Not a good fit for…

- Projects that need a server. Websockets, auth sessions, MongoDB, server-rendered routes. Use `hatchkit create` with the full-stack flow — that ends up on Coolify, not Pages.
- Next.js **without** `output: "export"`. GitHub Pages is static — Next's server features won't work. Use Vercel or the full-stack flow.

## Re-running

Safe. The command is idempotent:

- Pages enable: `POST` first, fallback to `PUT build_type=workflow` on `409 already exists`.
- Workflow file: refuses to overwrite — delete `.github/workflows/pages.yml` if you want a fresh one.
- Cloudflare DNS: updates records in place rather than duplicating them.
- Pages CNAME: `PUT` is an upsert.
