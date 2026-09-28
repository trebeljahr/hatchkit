# Changelog

All notable user-facing changes should be documented here.

This project follows npm package versions for the `hatchkit` CLI. Dates use `YYYY-MM-DD`.

## Unreleased

### Removed

- **`desktop-tauri` is gone.** Electron is the one desktop wrapper. Both wrapped the same static client export, so a second release pipeline bought nothing. Removed: `starter/src-tauri/`, `tauri-release.yml`, the four `tauri`/`icons:tauri` scripts, `@tauri-apps/cli`, the `tauri://localhost` + `http://tauri.localhost` trusted origins, and the `--features desktop-tauri` value. `hatchkit signing`'s `windows` platform now detects `electron/` instead of `src-tauri/` and its `build-windows.yml` builds an electron-builder NSIS installer signed with Azure Trusted Signing. An existing `.hatchkit.json` that lists `desktop-tauri` is migrated on read (manifest v5): the flag is dropped with a note, nothing is deleted from the project, and an already-deployed server keeps trusting the origins it already trusts — `TRUSTED_ORIGINS` is merge-only. A project that still wants Tauri should pin an older CLI or keep its `src-tauri/` tree by hand.
- The starter's `itch:push:{mac,win,linux}` scripts and the itch.io/butler steps in `desktop-release.yml`. The workflow now uploads each platform's installer as a build artifact; attach them to a release, or add a distribution step of your own.

### Added

- `hatchkit doctor --fix`: after the report, doctor offers the repairs it can apply itself, one `y/N` prompt each (default No; `--yes` applies them all). The first one pipes an escaped tx template's body through `Safe`. It reads the template again before the write and changes only the bare `{{ .Tx.Data.body }}` actions. Plain `doctor` and `doctor --json` stay read-only.
- **Scaffold-time identifier resolution** (`cli/src/scaffold/identifiers.ts`). Bundle id, product name, home-screen short name, storage and secret-store prefixes, the client and webhook header names, per-surface device-flow client ids, database name, export filename prefix, env-var prefix, npm scope and the desktop origin are now decided **once**, validated against the rules each platform actually enforces, and recorded in the manifest's new `identifiers` block (schema v5) — instead of being re-derived at five call sites under three different rules. `hatchkit signing` takes its bundle-id and app-name defaults from that block rather than computing its own, so the two can no longer disagree. Product name and short name are separate decisions from the project slug: `name` is what npm and the image registry use, `productName` is what a person reads, and `shortName` is the launcher label, which elides past about twelve characters. Organisation prefix defaults to the deliberately obvious `com.example` and `hatchkit create` warns while it is still there — an App ID, an App Store Connect record and a Play package name cannot be renamed once registered.
- **Cross-file identifier agreement check** (`cli/src/scaffold/identifier-agreement.ts`). The bundle id and the launcher label each live in up to four files that no single tool owns — `package.json`'s electron-builder block, `capacitor.config.ts`, the web app manifest, and the committed iOS and Android trees `cap add` generates. Every copy present is now read back and compared with the manifest, and a disagreement is reported with the file, the field and both values. A drifted copy previously surfaced as a store upload rejected days later with a message that named no file.
- The starter's web app manifest, which was an empty `{}` that nothing wrote, now carries the product and short names.
- `docs/feature-authoring.md` — the contract for adding an opt-in feature: registration, prerequisites, editing a file the user also edits without clobbering it, `--dry-run`, and what to test. Backed by a shared mechanism in `cli/src/features/contract.ts` (a feature registry with enforced `requires`, and a ledger that is the single `--dry-run` choke point and the only safe way to write) and `cli/src/features/templates.ts`.
- `docs/template-gaps.md` — 303 rows covering every gap between the starter template and a reference project taken to production, grouped by the twelve follow-up features, each with the invariant that fails quietly if it is done wrong.

- New `desktop-tauri` feature: a Tauri-based desktop wrapper aimed at games — much smaller binaries than Electron, plus Steamworks integration on the Rust side behind an opt-in `steam` cargo feature (`pnpm tauri build -- --features steam`). `hatchkit create` offers it after the feature checkbox whenever `mobile` (Capacitor) is selected and the Electron wrapper isn't; `hatchkit update` adds it to existing projects (idempotent on re-run). The starter ships `src-tauri/` (config, crate, capabilities, icons, entitlements) and a `tauri-release.yml` CI workflow with signed + notarized macOS builds and Azure Trusted Signing on Windows, both gated on the corresponding secrets. The two desktop wrappers are mutually exclusive — selecting both `desktop` and `desktop-tauri` is rejected with "pick one desktop wrapper".
- Added GitHub community health files, issue templates, release-note config, Dependabot config, and package metadata so the repository is easier to evaluate and contribute to.
- `hatchkit add <project> listmonk-ses` now auto-subscribes the user's configured forwarding email onto the project's `-test` Listmonk list as `confirmed`, and writes the address into `.env.development` as `LISTMONK_TEST_RECIPIENT`. Skipped silently when no default forwarding email is on file.
- Starter ships bundled smoke scripts: `pnpm newsletter:test-tx`, `pnpm newsletter:welcome`, and `pnpm newsletter:verify` — each defaults to `LISTMONK_TEST_RECIPIENT` so a fresh provision is one command away from a real send in your own inbox. Verify runs four checks (API reach, list ids, subscriber state, real tx send) and exits non-zero on the first failure.
- Starter ships pre-built example email HTML at `emails/welcome.html` and `emails/digest-sample.html`. Edit them; `pnpm newsletter:welcome` reads `welcome.html` and `pnpm newsletter:draft emails/digest-sample.html --subject "Issue 1"` stages the digest as a Listmonk draft.

### Changed

- Listmonk + SES is now the only supported email path. The opinionated email intent maps both transactional and newsletter needs to `listmonk-ses`; the starter ships a Listmonk `/api/tx` sender (with the matching `LISTMONK_*` env keys) in place of the Resend HTTP client.

### Fixed

- **Newsletter signups are real double opt-in.** `hatchkit add <project> listmonk-ses` created the Listmonk lists `optin: single`, and the starter's subscribe form added each address to the list as `unconfirmed` before the confirmation link was clicked. Listmonk sends a campaign on a single-opt-in list to every member not `unsubscribed`, so an address that never confirmed still got every campaign. New lists are now `optin: double`. The starter's form now creates the subscriber on no list (`ensureSubscriber`), and only the confirm link adds the list, as `confirmed` (`confirmSubscription`). With that order, Listmonk never sends its own opt-in email next to the app's. `upsertSubscriber` is gone; `newsletter:test-tx` and `newsletter:welcome` no longer add the recipient to a list. Existing lists are not switched: `add` on an adopted single-opt-in list and `hatchkit doctor` in the project report it, with the order to fix it in (deploy the confirm-only code first, then switch the list).
- The starter's and the CLI's Listmonk subscriber lookup used the `query` parameter, which needs the `subscribers:sql_query` permission that Listmonk's role form leaves out by default. Both now use an anchored `search` with regex characters quoted, so a plus-address such as `a+b@example.com` matches itself, and keep only the exact email from the results.
- Native clients (`mobile`, `desktop`, `desktop-tauri`) no longer fail sign-in with `403 INVALID_ORIGIN` on projects whose production env lives in Coolify. `hatchkit create`, `adopt`, `update` (after adding a native feature) and `sync` merge the shells' origins into `TRUSTED_ORIGINS` on the server Coolify app. Existing entries are kept in order and nothing is removed. The diff is confirmed before the write (`--yes` skips the prompt, `--dry-run` stops after the diff) and read back after it. `sync --deploy` redeploys the server; other paths print that a redeploy is needed. `sync`'s env pass now merges a `.env.production` `TRUSTED_ORIGINS` into the live value instead of overwriting it. The deploy workflow gains a "Verify native clients can sign in" step that probes each origin with `Sec-Fetch-Mode: cors` and fails on `403 INVALID_ORIGIN`.
- **Transactional emails no longer arrive as visible HTML markup.** `hatchkit add <project> listmonk-ses` seeded the `<project>-tx` template with a body of `{{ .Tx.Data.body }}`. Listmonk parses a tx template body with Go `html/template` (only the subject uses `text/template`), so that body HTML-escaped every confirmation and reset email. The seeded body is now `{{ .Tx.Data.body | Safe }}`; `Safe` is the helper Listmonk registers for tx templates (`safeHTML`, the earlier attempt, is not registered and fails to compile). `hatchkit doctor`, run in a project directory, reports a `<project>-tx` template that still has the bare body.
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
