---
sidebar_position: 6
title: GitHub Pages
---

# `hatchkit gh-pages`

Wire a GitHub Pages deployment for the **current repo** — including custom domain + DNS — in one command.

Built for the kind of project where `hatchkit create` is overkill: a sprite editor, a color-picker demo, a landing page, a palette tool, a SPA that talks to someone else's API, a `docs/` folder that you want live on the web.

## TL;DR

```bash
cd my-sprite-tool
hatchkit gh-pages
```

That's it. Hatchkit will:

1. Look up the repo via `gh repo view`.
2. Scan the repo root and the common subfolders (`docs/`, `site/`, `www/`, `web/`) for candidate sites.
3. If exactly one is found → auto-confirm. If multiple → prompt you to pick. If none → ask for kind + location manually.
4. Ask whether you want a custom domain.
5. Enable Pages via the GitHub API.
6. Write `.github/workflows/gh-pages.yml` (refusing to overwrite any existing Pages workflow).
7. If you asked for a custom domain: set the Pages CNAME, write a `CNAME` file, and wire your DNS provider (Cloudflare automatic; INWX / manual prints the records).

Commit the new workflow + CNAME, push, done.

## What it detects

Scans these locations: repo root, `docs/`, `site/`, `www/`, `web/`. In each, classifies the first of:

| Kind | Trigger | What the workflow does |
|---|---|---|
| **docusaurus** | `docusaurus.config.{ts,js,mjs}` | Node + detected pkg manager → `docusaurus build` → uploads `build/` → deploys. |
| **jekyll** | `Gemfile` + `_config.yml` | Sets up Ruby + bundler, `bundle exec jekyll build` with the correct `baseurl` + `working-directory`, uploads `_site`, deploys. |
| **node-build** | `package.json` has a `build` script (and isn't a workspace root) | Sets up your detected package manager (pnpm / npm / yarn / bun from the lockfile), installs + builds in the right `working-directory`, uploads the build output (`dist` / `build` / `out` / …), deploys. |
| **static** | `index.html` | Checks out, uploads the source folder as-is, deploys. |

For `node-build`, the publish dir is guessed from the build command (`vite` → `dist`, `react-scripts` → `build`, `astro` → `dist`, `next` → `out`) and you can override it before anything is written.

Docusaurus is detected before `node-build` because the build dir is fixed (`build/`) and `baseUrl` handling needs Pages-aware tweaking that the generic node flow doesn't do.

## Monorepos / hybrid layouts

If the same repo has both a root build **and** a `docs/` site (this repo, for example — a CLI at the root, a Docusaurus site under `docs/`), you'll get a picker:

```
Found 2 possible sites — pick one:
  ❯ docusaurus at docs/ → docs/build/
    node-build at repo root (pnpm run build → dist/)
```

Run the command twice if you want to deploy both — but note that Pages only serves **one** site per repo. Typical setups:

- CLI / app at the root, docs under `docs/` → deploy the docs (like hatchkit itself does).
- Marketing page at the root, admin tool under `admin/` → deploy the root, host admin elsewhere.

pnpm workspace roots (and other root `package.json`s with a `workspaces` field) are skipped from auto-detection — they rarely produce a single deployable site. You can still pick them via the manual fallback.

## Custom domain

When you say yes:

1. **Pages side:** `PUT /repos/:owner/:repo/pages -f cname=<domain>` — this is what makes GitHub serve the site at your domain and provision a cert.
2. **CNAME file:** written into the *published* folder:
   - Docusaurus → `static/CNAME` (Docusaurus copies `static/*` verbatim into `build/`).
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
hatchkit gh-pages              # → https://<user>.github.io/sprite-tool/
```

With a custom domain:

```bash
hatchkit gh-pages
# Custom domain? Yes
# Domain: sprites.example.com
# (Cloudflare configured → CNAME created automatically)
git add -A && git commit -m "ci: pages" && git push
# → https://sprites.example.com
```

## Docusaurus-size projects

If you're building a docs site with Docusaurus, `gh-pages` knows what to do:

```bash
npx create-docusaurus@latest my-docs classic --typescript
cd my-docs
git init && gh repo create my-docs --public --source=.
git add -A && git commit -m "init"
hatchkit gh-pages              # detects Docusaurus, writes the right workflow
```

The generated workflow uses your lockfile's package manager and runs `docusaurus build` with the Pages base path, then uploads `build/`.

## Not a good fit for…

- Projects that need a server. Websockets, auth sessions, MongoDB, server-rendered routes. Use `hatchkit create` with the full-stack flow — that ends up on Coolify, not Pages.
- Next.js **without** `output: "export"`. GitHub Pages is static — Next's server features won't work. Use Vercel or the full-stack flow.

## Re-running

Safe. The command is idempotent:

- Pages enable: `POST` first, fallback to `PUT build_type=workflow` on `409 already exists`.
- Workflow file: refuses to overwrite — delete `.github/workflows/gh-pages.yml` if you want a fresh one.
- Cloudflare DNS: updates records in place rather than duplicating them.
- Pages CNAME: `PUT` is an upsert.
