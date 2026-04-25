---
sidebar_position: 7
title: Deploying the docs site
---

# Deploying the docs site (GitHub Pages)

This page documents exactly how **this documentation site** is published. If you fork hatchkit or want a similar flow for your own project, copy the three files referenced below and change the URLs.

The site itself is built with [Docusaurus 3](https://docusaurus.io). The CI pipeline runs Node, builds the static site, and uploads it to GitHub Pages via the official actions.

## What's in the repo

| File | Role |
|---|---|
| [`docs/docusaurus.config.ts`](https://github.com/trebeljahr/hatchkit/blob/main/docs/docusaurus.config.ts) | Site config — title, base URL, theme, navbar, footer. |
| [`docs/sidebars.ts`](https://github.com/trebeljahr/hatchkit/blob/main/docs/sidebars.ts) | Sidebar order. Plain TS; one entry per page. |
| [`docs/package.json`](https://github.com/trebeljahr/hatchkit/blob/main/docs/package.json) | Docusaurus + plugin deps; `build` / `start` / `serve` scripts. |
| [`docs/docs/*.md`](https://github.com/trebeljahr/hatchkit/tree/main/docs/docs) | The actual content. Plain markdown with Docusaurus front matter. |
| [`docs/src/css/custom.css`](https://github.com/trebeljahr/hatchkit/blob/main/docs/src/css/custom.css) | Theme overrides on top of Docusaurus's classic theme. |
| [`.github/workflows/docs.yml`](https://github.com/trebeljahr/hatchkit/blob/main/.github/workflows/docs.yml) | The GitHub Actions workflow that builds + deploys Pages. |

## The deployment flow, end-to-end

```
┌──────────────────────┐     push to main     ┌──────────────────────┐
│ edit docs/docs/*.md  │ ───────────────────> │ GitHub Actions:      │
│ locally + commit     │  (docs/** changed)    │ docs.yml workflow   │
└──────────────────────┘                       └──────────┬───────────┘
                                                          │
                                      ┌───────────────────┴───────────────────┐
                                      ▼                                       ▼
                              ┌──────────────┐                         ┌──────────────┐
                              │ build job    │                         │ deploy job   │
                              │ Node 24 +    │   artifact upload       │ deploy-pages │
                              │ pnpm + cache │ ──────────────────────> │ → github.io  │
                              │ docusaurus   │                         │              │
                              │   build      │                         │              │
                              └──────────────┘                         └──────────────┘
```

The workflow has two jobs:

1. **build** — checks out the repo, sets up Node + pnpm, installs deps inside `docs/`, runs `pnpm build` (which calls `docusaurus build` with the Pages base path), and uploads `docs/build` as a Pages artifact.
2. **deploy** — calls `actions/deploy-pages@v4`. This is what publishes the artifact to the `github-pages` environment and returns the final URL.

### Path filters

The workflow only runs when something that affects the site actually changed:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "docs/**"
      - ".github/workflows/docs.yml"
  workflow_dispatch:
```

This keeps the CLI build pipeline fast and avoids rebuilding the site for every CLI commit.

### Permissions + concurrency

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false
```

- The three permissions are the exact minimum `actions/deploy-pages` needs.
- `cancel-in-progress: false` matters: if two commits land within seconds, we let the in-flight deploy finish before starting the next one — canceling would leave Pages in a half-updated state.

## Enabling it on a fresh repo

One-time setup in the GitHub UI:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   That's it. Don't pick a branch — we're publishing via the workflow, not from a branch's `/docs` folder or a `gh-pages` branch.
2. Push a commit that touches anything under `docs/` (or dispatch the workflow manually from the Actions tab).
3. The first successful deploy will print the URL in the `deploy` job's summary (e.g. `https://<user>.github.io/<repo>/`).

## Local preview

```bash
cd docs
pnpm install --ignore-workspace   # once; --ignore-workspace because docs/ isn't part of the monorepo's pnpm workspace
pnpm start                        # dev server with hot reload
# → http://localhost:3000/hatchkit/

# Or build + serve the production output exactly as Pages will:
pnpm build && pnpm serve
```

The `baseUrl: "/hatchkit/"` in `docusaurus.config.ts` means local URLs include the prefix too, matching what Pages serves. If you forked and renamed the repo, update `baseUrl` and `url` in the config.

## Why this setup?

- **Docusaurus** — first-class TypeScript config, search via Algolia or local plugin, built-in dark mode, MDX support. Dev experience is much closer to a normal Node app than the previous Jekyll setup.
- **Path-filtered workflow** — editing the CLI doesn't trigger a docs build, and editing docs doesn't trigger the CLI test matrix.
- **Actions-based deploy**, not the legacy "branch source" mode — cleaner permissions model, works even on private repos with Pro/Team.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 404 on every page after first deploy | Pages source not set to **GitHub Actions** in repo settings. |
| CSS / JS 404s | `baseUrl` in `docusaurus.config.ts` doesn't match the repo name. |
| `Module not found` in build log | `pnpm install` step missing or lockfile out of sync. |
| Workflow never runs | Your commit didn't touch a path in the filter, or Actions are disabled on the fork. |

## Just want this setup for your own repo?

Run `hatchkit gh-pages` from inside any repo with a Docusaurus site. It detects the config, writes the right workflow, optionally wires a custom domain at Cloudflare or INWX, and you're done. See [the `gh-pages` reference](./gh-pages).
