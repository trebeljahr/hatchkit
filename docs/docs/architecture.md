---
sidebar_position: 8
title: Architecture
---

# Architecture

A tour of what happens when you run `hatchkit create`, and how the pieces fit together.

## Repository layout

```
hatchkit/
├─ cli/              # the npm package `hatchkit`
│  └─ src/
│     ├─ index.ts         # top-level command dispatcher
│     ├─ prompts.ts       # interactive ProjectConfig collection
│     ├─ config.ts        # keychain + config.json + provider ensure()
│     ├─ scaffold/        # starter copy + feature strip + ports
│     ├─ provision/       # GlitchTip / OpenPanel / Resend clients
│     ├─ deploy/          # terraform, coolify, github, gpu, keys
│     ├─ doctor.ts        # provider health checks
│     └─ utils/           # flags, exec, validation, version
├─ starter/          # full-stack template (in-tree; subtree-merged)
├─ infra/            # Terraform + Coolify scripts (in-tree; subtree-merged)
├─ docs/             # this Docusaurus site
└─ services/ml/      # pre-built ML service templates
```

## Configuration surface

Three layers, in order of precedence:

1. **CLI flags** (`--yes`, `--config`, `--name`, `--no-github`, `--no-deploy`, `--dry-run`).
2. **Config file** passed via `--config <path>.json` — overrides prompt defaults field by field.
3. **Interactive prompts** — fill anything still unset.

The resulting `ProjectConfig` (project name, domain, features, ML selection, deploy target, ports, …) is the single source of truth threaded through the whole `create` flow.

## The `create` pipeline

```
prompts → ensure providers → scaffold app → install deps →
git + github → scaffold infra → terraform → coolify → ML deploy → summary
```

Key properties of the pipeline:

- **Lazy provider ensure.** We only prompt for Hetzner credentials if you actually selected "new VPS". We only prompt for GitHub if you said yes to the repo. Fails **early**, not after files are on disk.
- **Dry-run parity.** `--dry-run` still runs scaffold + infra generation so you see exactly what would change, but never mutates remote systems.
- **Unique ports.** A per-machine ports registry (`config.json#ports`) assigns collision-free `server` / `client` / `nativeHmr` ports so you can run many hatchkit apps locally.
- **Repo URL flows into infra.** GitHub runs **before** infra scaffold so the generated Coolify env has the real `GITHUB_REPO_URL` in it, not a placeholder.

## Secret handling

- **Provider tokens** → OS keychain (`keytar`), service name `hatchkit`.
- **Per-project encryption key** → OS keychain. Used by [dotenvx](https://dotenvx.com) to encrypt `.env.production` in the generated repo. Safe to commit the encrypted file; the private key is pushed to Coolify via API.
- **Provisioned service credentials** → printed at the end of `add`, plus cached under `<config-dir>/provisioned/<project>.{dev,prod}.env`.

## Scaffolding strategy

Feature stripping, not feature addition.

- The starter is maximal — it contains every feature hatchkit can produce.
- At scaffold time hatchkit **removes** anything you didn't pick (files, package.json deps, env keys, import paths).
- Why: features that can interact (auth + stripe + s3 + websockets) are battle-tested once in the starter rather than N times in hatchkit's scaffold code.

## Update strategy

`hatchkit update` only *adds* features. Removals are refused because the starter can't know which parts of the user-owned code path actually use the feature. Remove manually + update `.hatchkit.json`.

## Testing

`pnpm test` inside `cli/` runs a scaffold matrix: a dozen feature combinations, scaffolded into a temp dir, typechecked and lint-checked. CI runs the same matrix on every push.
