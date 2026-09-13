# Changelog

All notable user-facing changes should be documented here.

This project follows npm package versions for the `hatchkit` CLI. Dates use `YYYY-MM-DD`.

## Unreleased

### Added

- New `desktop-tauri` feature: a Tauri-based desktop wrapper aimed at games — much smaller binaries than Electron, plus Steamworks integration on the Rust side behind an opt-in `steam` cargo feature (`pnpm tauri build -- --features steam`). `hatchkit create` offers it after the feature checkbox whenever `mobile` (Capacitor) is selected and the Electron wrapper isn't; `hatchkit update` adds it to existing projects (idempotent on re-run). The starter ships `src-tauri/` (config, crate, capabilities, icons, entitlements) and a `tauri-release.yml` CI workflow with signed + notarized macOS builds and Azure Trusted Signing on Windows, both gated on the corresponding secrets. The two desktop wrappers are mutually exclusive — selecting both `desktop` and `desktop-tauri` is rejected with "pick one desktop wrapper".
- Added GitHub community health files, issue templates, release-note config, Dependabot config, and package metadata so the repository is easier to evaluate and contribute to.
- `hatchkit add <project> listmonk-ses` now auto-subscribes the user's configured forwarding email onto the project's `-test` Listmonk list as `confirmed`, and writes the address into `.env.development` as `LISTMONK_TEST_RECIPIENT`. Skipped silently when no default forwarding email is on file.
- Starter ships bundled smoke scripts: `pnpm newsletter:test-tx`, `pnpm newsletter:welcome`, and `pnpm newsletter:verify` — each defaults to `LISTMONK_TEST_RECIPIENT` so a fresh provision is one command away from a real send in your own inbox. Verify runs four checks (API reach, list ids, subscriber state, real tx send) and exits non-zero on the first failure.
- Starter ships pre-built example email HTML at `emails/welcome.html` and `emails/digest-sample.html`. Edit them; `pnpm newsletter:welcome` reads `welcome.html` and `pnpm newsletter:draft emails/digest-sample.html --subject "Issue 1"` stages the digest as a Listmonk draft.

### Changed

- Listmonk + SES is now the only supported email path. The opinionated email intent maps both transactional and newsletter needs to `listmonk-ses`; the starter ships a Listmonk `/api/tx` sender (with the matching `LISTMONK_*` env keys) in place of the Resend HTTP client.

### Fixed

- Native clients (`mobile`, `desktop`, `desktop-tauri`) no longer fail sign-in with `403 INVALID_ORIGIN` on projects whose production env lives in Coolify. `hatchkit create`, `adopt`, `update` (after adding a native feature) and `sync` merge the shells' origins into `TRUSTED_ORIGINS` on the server Coolify app. Existing entries are kept in order and nothing is removed. The diff is confirmed before the write (`--yes` skips the prompt, `--dry-run` stops after the diff) and read back after it. `sync --deploy` redeploys the server; other paths print that a redeploy is needed. `sync`'s env pass now merges a `.env.production` `TRUSTED_ORIGINS` into the live value instead of overwriting it. The deploy workflow gains a "Verify native clients can sign in" step that probes each origin with `Sec-Fetch-Mode: cors` and fails on `403 INVALID_ORIGIN`.
- Fixed the Listmonk transactional template seeded by `hatchkit add <project> listmonk-ses` — tx templates use Go `text/template`, which doesn't register `safeHTML`, so the body now renders `{{ .Tx.Data.body }}` raw instead of failing with `function "safeHTML" not defined`.
- `fix(dns): preserve Cloudflare API token across legacy-provider auto-migration` — `ensureDns` no longer wipes `dns:cloudflare:token` when migrating a pre-v2 `inwx`/`manual` DNS config. The token is read first, verified against `GET /user/tokens/verify`, and reused under the new `provider: "cloudflare"` meta so users keep their existing token instead of being forced to roll + re-paste (Cloudflare never re-exposes token values). Only the `dns:inwx:password` secret and the stale `provider` field are cleared. Explicit `hatchkit config add dns` still wipes both — that path is user-initiated.

### Removed

- Removed the Resend provider, configure flow, provision/destroy paths, and all `--resend-*` flags from `hatchkit add`. The starter's email service and `better-auth` reset/verify hooks now talk to Listmonk + SES; existing projects keep working until their next provisioning run.

## 0.2.13

### Added

- Added Listmonk newsletter subscribe/confirm handlers plus newsletter send and draft scripts.
- Added an opinionated email intent prompt for choosing Resend transactional email or Listmonk+SES newsletters.
- Added an opinionated S3 prompt that defaults new projects to Cloudflare R2 while preserving existing-storage setup.
- Added Listmonk+SES provisioning for transactional/campaign templates and `LISTMONK_TEST_LIST_ID`/`LISTMONK_FROM` env surfaces.

## 0.1.47

- Previous published CLI version.
