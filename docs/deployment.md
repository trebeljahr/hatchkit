---
title: Deploying the docs site
nav_order: 8
---

# Deploying the docs site (GitHub Pages)

This page documents exactly how **this documentation site** is published. If you fork hatchkit or want a similar flow for your own project, copy the three files referenced below and change the URL.

## What's in the repo

| File | Role |
|---|---|
| [`docs/_config.yml`](https://github.com/trebeljahr/hatchkit/blob/main/docs/_config.yml) | Jekyll site config. Uses the `just-the-docs` **remote theme** so there's nothing to vendor in. |
| [`docs/Gemfile`](https://github.com/trebeljahr/hatchkit/blob/main/docs/Gemfile) | Ruby deps — pinned to Jekyll 4.3 + just-the-docs. |
| [`docs/*.md`](https://github.com/trebeljahr/hatchkit/tree/main/docs) | The actual content (this file, `index.md`, etc). Plain markdown with front matter. |
| [`.github/workflows/docs.yml`](https://github.com/trebeljahr/hatchkit/blob/main/.github/workflows/docs.yml) | The GitHub Actions workflow that builds + deploys Pages. |

## The deployment flow, end-to-end

```
┌──────────────────────┐     push to main     ┌──────────────────────┐
│ edit docs/*.md       │ ───────────────────> │ GitHub Actions:      │
│ locally + commit     │  (docs/** changed)    │ docs.yml workflow   │
└──────────────────────┘                       └──────────┬───────────┘
                                                          │
                                      ┌───────────────────┴───────────────────┐
                                      ▼                                       ▼
                              ┌──────────────┐                         ┌──────────────┐
                              │ build job    │                         │ deploy job   │
                              │ ruby 3.2 +   │   artifact upload       │ deploy-pages │
                              │ bundler      │ ──────────────────────> │ → github.io  │
                              │ jekyll build │                         │              │
                              └──────────────┘                         └──────────────┘
```

The workflow is defined in [`.github/workflows/docs.yml`](https://github.com/trebeljahr/hatchkit/blob/main/.github/workflows/docs.yml) and has two jobs:

1. **build** — checks out the repo, sets up Ruby, runs `bundle install` (cached via `ruby/setup-ruby`'s `bundler-cache`), runs `jekyll build` with the correct `--baseurl`, and uploads `docs/_site` as a Pages artifact.
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
bundle install          # once
bundle exec jekyll serve --livereload
# → http://127.0.0.1:4000/hatchkit/
```

The `baseurl: "/hatchkit"` in `_config.yml` means local URLs include the prefix too, matching what Pages serves. If you forked and renamed the repo, update `baseurl` and `url` in `_config.yml`.

## Why this setup?

- **No custom static site generator to learn** — it's just Markdown with YAML front matter.
- **Remote theme** — no vendored CSS or theme files in the repo; `just-the-docs` ships nav, search, dark mode, and heading anchors out of the box.
- **Path-filtered workflow** — editing the CLI doesn't trigger a docs build, and editing docs doesn't trigger the CLI test matrix.
- **Actions-based deploy**, not the legacy "branch source" mode — cleaner permissions model, works even on private repos with Pro/Team.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 404 on every page after first deploy | Pages source not set to **GitHub Actions** in repo settings. |
| CSS / JS 404s | `baseurl` in `_config.yml` doesn't match the repo name. |
| `Could not find just-the-docs` in the build log | `docs/Gemfile` missing or `bundler-cache` couldn't resolve. Delete `docs/Gemfile.lock` and re-push. |
| Workflow never runs | Your commit didn't touch a path in the filter, or Actions are disabled on the fork. |
