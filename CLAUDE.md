# Hatchkit Agent Memory

This repository is Hatchkit. Hatchkit is a CLI for taking a product from idea to
running app on user-owned infra:

scaffold -> deploy -> provision -> maintain.

Use the `.claude/skills/hatchkit` skill whenever the user mentions Hatchkit, the
CLI, scaffolding a new app, Coolify/Hetzner/DNS/R2/Resend, dotenvx keys, provider
credentials, GitHub Pages wiring, repo adoption, or project provisioning.

## First Step

Before recommending Hatchkit commands, run:

```bash
hatchkit status --json
```

Read `providers[]`, `nextStep`, and `suggestions[]`. Do not guess the user's
current setup.

If `@hatchkit/mcp` is available, prefer the read-only MCP tools:
`hatchkit_status`, `hatchkit_doctor`, `hatchkit_explain`, and
`hatchkit_keys_show`.

## Safe Diagnosis

For failures:

```bash
hatchkit doctor --json
```

Report the failing `checks[].hint[]` lines. They contain the exact credential
rotation URL, scopes, and `hatchkit config add <provider>` command.

## Command Shape

- `hatchkit setup` / `init`: interactive credential onboarding.
- `hatchkit create`: interactive scaffold/deploy flow.
- `hatchkit update`: add supported features to an existing project
  (`workspaces`, `desktop`, `mobile`, `release`, `auth-account-security`,
  `client-core`). `--features <list>` answers the picker, `--auth-options
  <list>` answers the account-security multiselect, `--dry-run` reports
  what would change without writing, `--json` prints the result. Never removes
  a feature. The list lives in `SUPPORTED_ADDITIONS`
  (`cli/src/scaffold/update.ts`) — read it rather than this line, which has
  gone stale before.
- `hatchkit auth providers [dir] [--provider google|apple|github|discord]
  [--dry-run] [--verify]`: after `update --auth-options` picked OAuth
  buttons, register each provider's app and store its keys in
  `.env.production` (client IDs plain, secrets encrypted). GitHub: a
  sign-in-only GitHub App through the manifest flow (one confirmation on
  github.com, `POST /app-manifests/{code}/conversions`; public, email
  addresses read-only; `--github-oauth-app` for the guided OAuth app).
  Google, Apple, Discord have no API: dashboard URLs + values to paste,
  then each value from the clipboard on Enter (never echoed, clipboard
  emptied), Apple's `.p8` from Downloads to the Trash. Shape checks, then
  offers `sync --deploy` and checks `/api/auth/sign-in/social`'s
  `client_id` + `redirect_uri`. Needs a terminal except `--dry-run` /
  `--verify`. See `cli/src/auth-providers/plan.ts` for why a GitHub App
  works with better-auth; test `test-auth-providers.ts` (fake GitHub,
  clipboard, Trash, deployed app).
- `hatchkit add <project> [services]`: provision GlitchTip/Plausible/Resend/S3/email.
- `hatchkit keys show|push|rotate <project>`: manage dotenvx private keys.
- `hatchkit secrets rotate <project>`: rotate one project's provider
  credentials (`r2`, `local-secrets`, `glitchtip`).
  `hatchkit secrets rotate --global ses|listmonk`: rotate a credential shared
  across projects and update every local project, Coolify app and ListMonk
  setting that holds it. Both refuse while the dotenvx key is in git history
  (`keys rotate` first). Start with `--dry-run`; never pushes.
- `hatchkit secrets isolate <project> | --all [--app <uuid>[:client|:server]] [--dry-run] [--rotate]`: take
  hatchkit's Coolify token out of a project — per-app signed deploy webhooks,
  `:live` promoted in GHCR, token secrets deleted. A Docker Image app's
  placeholder `git_repository` becomes the repo's origin (after the watch
  path). A Worker repo with its API on Coolify (`--app`, or `clientHost:
  "cloudflare"` → the server app) gets the Worker token AND the hooks. A role
  in `--app` picks `COOLIFY_<ROLE>_*` and deletes the unprefixed set; a run
  whose set no workflow reads stops before writing; a workflow that signs a
  hook itself is never rewritten. `--dry-run` prints the real run's
  set/delete plan. See `cli/src/deploy/coolify-deploy-hook.ts` for why no
  Coolify token can be scoped to one app.
- `hatchkit gh-pages`: configure GitHub Pages for the current repo.
- `hatchkit cloudflare`: configure Cloudflare Workers Static Assets for the
  current repo (static sites; free, unmetered asset requests).
  `hatchkit cloudflare token [--worker <name>] [--also-worker <name>…] [--dry-run]`
  only mints the repo's per-Worker deploy token and sets the two
  CLOUDFLARE_* secrets; `--also-worker` gives a repo whose CI uploads
  several Workers one token on exactly those Workers (record under the
  first, `workers`/`workerIds`).
  `hatchkit cloudflare routes [--remove] [--dry-run]` makes (or deletes,
  `<host>/*` first) a routed Worker site's Workers routes from
  `clientWorkers`, after a preflight per Worker; created routes are ledger
  steps.
  `hatchkit cloudflare https add|remove <host…>` edits hatchkit's one
  HTTP→HTTPS redirect rule per zone (re-read after each write);
  `hatchkit cloudflare redirect add <host> <https-origin>` moves a
  redirect-only host from a Coolify app to the zone. `--dry-run` first.
  Setup and `--undo` refuse a project with `clientHost: "cloudflare"`
  (its Worker is on routes, not a Custom Domain).
- A site with no server on an assets-only Worker attached by Workers
  routes: manifest `deploymentMode: "cloudflare"` + `clientHost:
  "cloudflare"` (+ optional `clientWorker`; `clientWorkers` when the
  hosts are not all on one Worker: host → Worker, null for a host
  hatchkit's redirect rule answers, or an exact route pattern → another
  Worker; `clientRelease: "repo"` when the repo's CI owns wrangler.jsonc,
  `_headers` and the release workflow). `sync`, `regen-infra`, `dns
  publish` and `rename-domain` leave it alone; `doctor` reads the routes,
  Workers, redirect rules and HTTPS rule per zone; `status --json` prints
  `project.deployment`. See
  `cli/src/deploy/routed-worker-site.ts`.
- `hatchkit adopt`: bring an existing repo under Hatchkit conventions.
- `hatchkit sync`, `rename-domain`, `regen-infra`, `provision s3`: maintain deployed projects. `sync` pushes the manifest's `domain` + `aliases[]` (multi-hostname) onto Coolify. On an image app whose image answers the `X-Hatchkit-Drain` probe, `sync` also rewrites its Coolify labels so Traefik's own health check drains a stopping container, and slows Docker's check; `--no-traefik-drain` undoes it. See `cli/src/deploy/traefik-drain.ts` for why the routers are renamed.
- `hatchkit provision s3 cache-rule [--public-hostname <h>] [--dry-run] [--purge] [--override-bypass]`: only the edge Cache Rule step of `provision s3` (which runs it after attaching the custom domain; `--no-cache-rule` skips it). One rule per host in the zone's `http_request_cache_settings` phase, found by description `hatchkit: cache <host>`: cache eligible, edge TTL `respect_origin`, 4xx/5xx `no-store`. Appends/patches only its own rule; an enabled bypass rule that may match the host stops it. Needs Zone → Cache Rules → Edit (+ Cache Purge → Purge for `--purge`). Check with GET: R2 custom domains answer HEAD with DYNAMIC even when cached. See `cli/src/provision/r2-cache-rule.ts`.
- `hatchkit migrate-runtime [app] [--dry-run|--rollback|--cleanup]`: move a deployed Coolify compose app to Docker Image apps (rolling, zero-downtime deploys). Side by side with a verified cutover; refuses apps holding data, except a named volume asked for with `--carry-volume <service>=<volume>` (the new app mounts the same Docker volume; two containers write it during verification and every rolling deploy; `--same-json <service>=/path:<field>` compares production and the new app before the cutover). See `cli/src/deploy/image-runtime.ts` for why compose apps go down on every deploy. Traefik checks go to `HATCHKIT_TRAEFIK_ADDRESS`, else the tailnet IP of the backup host on the app's server, else the public IPv4 (`cli/src/deploy/traefik-address.ts`); `--dry-run` probes it.
- `hatchkit migrate-client [--dry-run|--repo-only|--rollback|--cleanup]`: serve a deployed fullstack project's client from Cloudflare Workers static assets while the API stays on Coolify, same hostname. Workers routes `<domain>/api/*` (and the ACME path) with no Worker, `<domain>/*` → the assets-only Worker; manifest `clientHost: "cloudflare"` (+ optional `originPaths`; `/x` routes `/x/*`, `/x*` also the bare `/x`, e.g. a WebSocket at `wss://<domain>/trpc`). The Coolify client app keeps running until `--cleanup`; `--rollback` is a route deletion. See `cli/src/deploy/client-host.ts` and `migrate-client.ts`.
- `hatchkit dns publish [--dry-run]`: upsert Cloudflare A/AAAA records for the manifest's domain + aliases, pointing at the Coolify server.
- `hatchkit plausible rename <old> <new>`: move a Plausible site to a new domain (stats history preserved).
- `hatchkit plausible merge <old> <new> [--dry-run] [--allow-overlap] [--host <name>] [--yes]`:
  Community Edition (no Sites API): fold the old site into an existing new
  site in Postgres + ClickHouse on the backup host that runs Plausible.
  Refuses missing sites, overlapping event ranges, swapped domains, imported
  data and a half-done earlier merge; backs up (pg_dump + `premerge_<date>_site<id>_*`
  tables), copies rows, moves the start dates back, copies goals, deletes the
  old site. Production write: `--dry-run` first, ask before the real run.
  See `cli/src/host/plausible-merge.ts`.
- `hatchkit listmonk user <project> [--dry-run]`: give a project its own Listmonk API user (user role + list role + API user, needs the `hatchkit-admin` token in keychain `listmonk:admin-api-token`) and rewrite LISTMONK_API_USER/TOKEN in its env. Never pushes; `hatchkit sync` after. `hatchkit add … listmonk-ses` does the same for new projects.
- `hatchkit listmonk list <project> <key> [--name <live list name>] [--dry-run]`: one more private, double-opt-in list pair (live + `<project>-<key>-test`) for a project that already has its own Listmonk API user, granted to its list role. Reuses lists found by name, never changes them; prints the ids, writes no env. Admin credential, like `user`.
- `hatchkit listmonk broker [--hostname <host>] [--dry-run]`: once per Listmonk instance, the confirm broker (`--hostname`: Custom Domain in one of the account's zones, needed when a WAF rule admits only Workers on your zones to Listmonk `/api/*`). Listmonk role + API user `hatchkit-confirm-broker` (`subscribers:get_all`, `subscribers:manage`, `lists:manage_all`; token in keychain `listmonk:confirm-broker:api-token`) and the Worker `hatchkit-listmonk-broker` (compiled `cli/src/listmonk-broker/worker.ts`, uploaded like the audit Worker), URL saved in config `listmonkBroker`. A project with `LISTMONK_CONFIRM_BROKER_URL` calls `POST /confirm` only after its own `PUT /api/subscribers/lists` got 403 (the address is on another project's list); the broker reads the caller's rights via `/api/profile` with the caller's token and only adds that list as confirmed. Admin credential + Cloudflare operator token; ask before running it for real. Test: `test-listmonk-broker.ts`.
- `hatchkit add <project> lead-magnet [--key <k> --title <t> (--object <bucket key>|--url <https>) [--filename <f>] | --key <k> --remove] [--dry-run]`: edit the newsletter's `magnets.json` (starter `packages/server/src/services/newsletter/`, or a static site's `workers/newsletter/src/`); no flags lists them. Local file only, warns about missing env; never uploads the file. Delivery and the download route live in the starter's `services/newsletter/` (`magnets.ts`); the static-site Worker port is `cli/src/templates/newsletter-worker/` (not scaffolded).
- `hatchkit add <project> paid-unlock [--runtime worker|server] [--key <k> --name <n> --kind page|download|email (--price <9>|--min <3> [--suggested <8>]) [--interval month|year] [--files <obj[:name]>,…] [--email <f.html>] [--inactive|--remove]] [--dry-run]`: Stripe Checkout → a page, a download or one email, one-time or subscription, no buyer database (the paid Checkout Session is the record; an HMAC cookie/email link the proof; refund, dispute or ended subscription ends access). Writes the runtime (`workers/unlock/` Cloudflare Worker on `/api/unlock/*` + `/paid/*` routes, or `services/unlock/` mounted in the starter's `app.ts` before `express.json()`) and edits its `unlocks.json`. Both runtimes copy `cli/src/paid-unlock/core.ts` verbatim (fetch + WebCrypto only; `scripts/copy-templates.mjs` ships its `.ts` source into `dist/paid-unlock/`). Local files only.
- `hatchkit stripe sync [dir] --mode test|live [--account acct_…] [--webhook-url <url>] [--archive-removed] [--recreate-webhook] [--dry-run] [--json] [--yes]`: products `hk_<project>_<key>`, prices by lookup key `hatchkit:<project>:<key>` (a new amount = new Price + `transfer_lookup_key`, old archived), live webhook `https://<domain>/api/unlock/webhook`. Never deletes. Writes with the organization key (`hatchkit stripe org-key`, keychain `stripe:org:<mode>:secret-key`) + `Stripe-Context`, else the project's own key. Live shows the plan and asks. Webhook secret → keychain + `.dev.vars` / `.env.development.local` (test) or `.env.production` (live server); `hatchkit stripe webhook-secret` prints it for `wrangler secret put`. Tests: `test-paid-unlock.ts`, `test-stripe-sync.ts` (fake Stripe in `test-support/fake-stripe.ts`).
- Stripe webhooks land in the project's own account. `hatchkit add <project> stripe`, `create` and `adopt` create the starter's `/api/stripe/webhook` with the same key choice as `stripe sync` (`resolveSyncClient`: org key + `stripe.accounts[mode]`, else the project's key). No global Stripe key is needed: `config add stripe` stores only optional organization keys (`storeStripeOrgKey`, same as `stripe org-key`), and create/adopt/add ask for the project's keys per mode (skip allowed; remembered for the run; skipped without a TTY). Before that, `ensureStripeForProject` (`cli/src/provision/stripe-setup.ts`) checks each mode: ready with org key + `stripe.accounts[mode]` or the project's key; else (TTY) it shows the dashboard steps and waits for the org key + `acct_…` (checked with one read), the project's own key, or a skip; answers hold for the run (create's pre-flight asks, wiring reuses) and the account is saved to `stripe.accounts` (create, adopt, add, sync). `stripe sync` runs it for one mode (`only`, `ownKey: "paste"`: it takes and checks the project's sk itself). Until 2026-11-08 setup asked for a master key per mode; a stored one is read only to find the endpoints it created (rename-domain and destroy look up by id: project account, then master; `doctor` lists it as legacy). `doctor` also warns, with the fix, about recorded webhook endpoints no stored key reaches (`stripeWebhookRows`). Tests: `test-stripe-config.ts`, `test-stripe-setup.ts` (scripted prompts via `_setStripeSetupPromptsForTests`; `null` = no terminal). Every endpoint hatchkit creates is a `stripeWebhook` run-ledger step (`appendLedgerStep` for commands after create); `destroy` deletes it by id in that account and drops its keychain id + secret; products stay. Older ledgers' `keychain` webhook-id steps delete their endpoint too. `migrate-domain` cutover repoints both kinds in place, keeping the secret (`stripe:webhook`; `stripe:unlock-webhook`, planned only with an `unlocks.json` or a stored unlock id, moved only while on the old host; gated on `detectStripeFacts`: any key that reaches the project; an unreachable recorded endpoint defers the step). Test: `test-stripe-webhook-account.ts` (several fake accounts behind one fetch).
- `hatchkit backup sources [--project <name>]`: read-only; resolves every
  registered backup selector on the host and prints the exact fix for stale
  ones (`backup update-source … --container|--remove`, `backup deregister`,
  both `--dry-run` first). Also part of `backup status` and `doctor`.
  `destroy` and `migrate-runtime --cleanup` remove sources of what they delete.
  Several backup hosts: `backup hosts`, `backup add-host`; `--host <name>`
  picks one, else a `--project` command finds the project's host. A project
  lives on one host; `backup register` on another host moves it (guarded).
- `hatchkit host integrity [--cpu-window <s>] [--json]`: read-only scan of
  the backup host for a compromised container (deleted binaries, process
  names the image does not explain, new files in /tmp, /var/tmp, /dev/shm,
  >50 % of a core, outbound peers outside private ranges and Cloudflare).
  Also a `doctor` row. `install [--dry-run]` adds a daily timer that mails
  new findings through the backup-alert SMTP (production write; ask first).
  Exceptions: `/etc/hatchkit-backups/host-integrity.json` on the host. See
  `cli/src/host/integrity.ts`.
- `hatchkit host updates [--host <name>] [--json]`: read-only; the running
  version of Coolify, Traefik, Plausible CE, Listmonk, Uptime Kuma, GlitchTip
  and ClickHouse on every backup host against each repo's GitHub security
  advisories and latest release, plus Coolify's failing auto-update and
  Cloudflare IP ranges that drifted from `HATCHKIT-CF` / Hetzner firewalls /
  the pinned snapshot. One `doctor` row. `install --host <name> [--dry-run]` adds a weekly timer that
  records findings for the daily digest and mails only a crash or a new urgent
  finding (production write; ask first). See `cli/src/host/updates.ts`.
- Alert mail: `cli/src/templates/backups/ops_digest.py` builds one digest per host
  inside the hourly backup-alerts service. `hatchkit_mail.py` and
  `security-controller/mail-core.mjs` render the same bytes;
  `cli/test-ops-digest.py` pins that, the gating and the size cap.
- App image fixes come from each repo's own pipeline, never from a host (no
  host holds a GitHub token): `apt-get upgrade` in the runtime stage, and
  `cli/src/templates/dependency-updates/` (Dependabot npm config + a daily
  workflow that tests, squash-merges and deploys the grouped PR).
  `templates/base-refresh/` is a manual rebuild of the live commit.
- Automatic service patches: `cli/src/templates/update-watch/service-patches.py`
  applies Traefik and Uptime Kuma patch releases (same major.minor) with a
  no-network canary, a routed-host sweep, network reconnects and automatic
  rollback, and keeps Coolify's stored compose copies in step (`sync-coolify`).
  Postgres (`kind: postgres`, digest-pinned `X.Y-alpine`): a higher minor of the
  same major or an upstream rebuild of the tag; the old and new image must read
  one snapshot copy to the same exact row counts before the recreate.
  A known-exploited image-package finding (fix reported) on the running image
  is patched at once, outside the window and age wait, when the candidate's own
  `apk` shows the fixed version; otherwise the plan lists it as `exploitedUnfixed`.
  Kuma security overlay (`overlay --target --packages`): a local
  `localhost/hatchkit-overlay/uptime-kuma:<tag>-hk<n>` FROM the pinned
  upstream digest with only those Debian packages upgraded; `run` leaves it for
  the first upstream image that carries every overlay package version.
  Installed by `host updates install`, never enabled by it; config
  `/etc/hatchkit-security/service-patches.json` + timer are the operator's.
- `hatchkit audit cloudflare [--json] [--hours <n>]`: read-only check of the
  Cloudflare account against what hatchkit created: tokens it has no record
  of (by id), audit-log entries by the operator token outside a recorded
  hatchkit run or by an unknown credential, and Workers, buckets, zones, Email
  Routing, members and OAuth clients nobody accepted. Reads with its own
  read-only token (`HATCHKIT_CLOUDFLARE_AUDIT_TOKEN` or keychain
  `cloudflare:audit`), never the operator token. The Worker `hatchkit-audit`
  runs it every 6 h and mails through SES only on findings; `deploy` and
  `publish` write that Worker and its bucket with the operator token (ask
  first). `accept`/`forget` change the local allowlist. See `cli/src/audit/`.
- `hatchkit mac-runner status|on|off|serve [--run <id>]|run <workflow>`:
  run a private repo's Apple jobs on this Mac instead of GitHub's macOS
  runners (10x minutes). The jobs read `runs-on: ${{ vars.APPLE_RUNNER ||
  'macos-15' }}`; `on` sets the variable (refuses a public repo), `serve`
  registers a just-in-time runner only while it runs and hosts the queued
  jobs until the watched runs finish, `run` dispatches and serves. A job
  nobody serves fails after 24 h. Jobs get a minimal environment (no
  operator tokens). See `cli/src/mac-runner/`.
- `hatchkit infra plan|apply|output <stack>`: run hatchkit's own Terraform
  stacks (today `ota-updates`, the Capacitor live-update endpoint at
  ota.ricoslabs.com, code in `infra/ota-updates/`). Each run mints a 1 h
  token with only the stack's grants (`INFRA_STACKS` in
  `cli/src/infra/command.ts`); `apply` applies only the saved `tfplan`.
  Ask before `apply`, and show the plan first.
- `hatchkit map [--out <file>] [--open] [--json] [--extras <file>] [--stack-dir <dir>] [--no-ssh] [--no-github]`:
  read-only fleet map. Collectors in `cli/src/map/collect.ts` + `discover.ts`
  (GETs, `systemctl show` over tailscale ssh, launchctl, tailscale status, gh);
  `build.ts` turns facts + the operator's extras YAML
  (`~/.config/hatchkit/map-extras.yaml`) into nodes/components/edges with a
  tier each (listed by overview / set up by hatchkit / outside); `layout.ts`
  draws the SVG plate, `render.ts` the page. Facts never carry IPs, account ids
  or UUIDs (joins happen inside the collectors). Test: `test-fleet-map.ts`.
- `hatchkit explain --json`: source-of-truth mental model.

Check `hatchkit help <command>` before using flags you have not verified.

## Safety

- `hatchkit doctor` is read-only. `hatchkit doctor --fix` is not: it offers
  repairs that write to providers (y/N each; `--yes` applies them all). Ask
  before running it.
- Do not run interactive commands unattended unless the user gave automation
  flags/config.
- Mutating commands can touch local files, GitHub, DNS, Terraform, Coolify, and
  provider APIs. Make sure the user asked for that action.
- Never print secrets unless specifically requested.
- Treat `hatchkit config reset` as destructive.
- For commands that could break an existing setup, report first and give the
  command to the user. Prefer `--dry-run`, `--json`, or `--recipe`.
- Know the undo path before executing mutations. `hatchkit destroy <project>
  --recipe` prints rollback commands without executing; `hatchkit gh-pages
  --undo --dry-run` previews Pages cleanup; `hatchkit cloudflare --undo
  --dry-run` previews the Workers cleanup; create/adopt ledgers let
  `hatchkit destroy <project>` undo resources Hatchkit created.
- Ask before running rollback, cleanup, Terraform, DNS, Coolify, keychain, or
  provider API mutations.

## Public repository: no operator data

Hatchkit is public. Commit generic tooling only. Never commit one operator's
fleet: host names, tailnet names or addresses, public IPs, Coolify resource
UUIDs, Worker URLs, mail addresses, per-app rollout notes, or run scripts and
evidence written for specific hosts. Keep those out of this repo: delete
one-off run scripts after the run, and keep records in the operator's private
notes. Tests and docs use made-up names (`app-vps`, `ops-vps`,
`example.com`, `203.0.113.0/24`, `100.64.0.0/10`).

The pre-push hook refuses a push that adds `infra/maintenance/`, or whose added
lines contain a fixed string from `~/.config/hatchkit/fleet-denylist` (or the
file named by `$HATCHKIT_FLEET_DENYLIST`). The denylist lives outside the repo,
so the repo never names what it guards against.

## Break/Fix Workflow

If Hatchkit is breaking, diagnose and report first. Then, if useful, write a
repair prompt for another agent or a follow-up session.

Include in the repair prompt:

- Failing command, cwd, Hatchkit version, and output.
- Safe checks run: `hatchkit status --json`, `hatchkit doctor --json`, and
  relevant `hatchkit help <command>`.
- Suspected files, expected behavior, risk/blast radius, rollback path, and
  validation commands.
- Safety instruction: preserve existing user setups, use dry-run or isolated
  `HATCHKIT_CONF_DIR` where possible, and ask before provider/DNS/Coolify/
  Terraform/keychain mutations.

## Development

```bash
pnpm install
pnpm --filter hatchkit run dev
pnpm --filter hatchkit run typecheck
pnpm --filter hatchkit run check
pnpm --filter hatchkit install-local
```

Key paths:

- `cli/src/index.ts`: command router and help text.
- `cli/src/config.ts`: provider config and keychain metadata.
- `cli/src/status.ts`: status JSON.
- `cli/src/doctor.ts`: health checks and hints.
- `cli/src/explain.ts`: mental model.
- `cli/src/scaffold/`: scaffolding.
- `.hatchkit.json` writes: `readManifest` migrates old schemas in memory
  only. A command that records a value calls `patchManifest` (its own
  top-level keys onto the file as it is on disk); `writeManifest` is for
  `create`, `adopt`, `update` and a new file. `cli/test-manifest-patch.ts`
  pins the `writeManifest` callers.
- `cli/src/features/auth-account-security/`: opt-in account-security feature
  (two-factor, account controls, extra sign-in methods). Additive via
  `hatchkit update`. `plugin-order.ts` holds the one rule that fails
  silently — `bearer()` must be registered after every plugin that can
  replace the session — and `cli/test-auth-account-security.ts` pins it by
  reading the GENERATED `auth.ts`.
- `cli/src/features/client-core/`: opt-in host-free client kit (offline queue,
  sync client, client/server version handshake). Additive via `hatchkit update`.
  `markers.ts` holds the convention that keeps the create-time strip from
  drifting, and `cli/test-client-core.ts` pins it by round-tripping the starter.
- `cli/src/features/site-basics/`: operational module (create + every
  `update`) writing the web client's sitemap, robots, canonical, social
  cards, JSON-LD and Plausible mount. Owned `lib/site/*` regenerate from the
  manifest; route files, `og.png` and the layout are the project's (write if
  absent / fixed-point edit). Plausible reaches the build only through repo
  variables: `provision/plausible-delivery.ts`. Tests:
  `test-site-basics.ts`, `test-plausible-delivery.ts`.
- `cli/src/deploy/`: Coolify, Terraform, GitHub, keys, pages, rollback.
- `cli/src/features/`: opt-in features. `signing/` provisions release
  signing; `server-platform/` + `server-migrations/`, `scheduler/`,
  `public-api/` write server infrastructure into an already-scaffolded
  project. These are ADDITIVE — nothing of theirs ships in `starter/`, so
  `create` and `update` run the same writer and re-running is a no-op.
  Their file bodies live in `cli/src/templates/features/<id>/` as `.tpl`
  (a `.ts` there would be typechecked by the CLI's own tsconfig).
- `cli/src/provision/`: provider/client provisioning.
- `starter/`: scaffold template.
- `infra/`: Terraform/Coolify automation.
- `services/`: ML templates.
- `mcp/src/index.ts`: read-only MCP server.
- `docs/content/docs/`: docs source.
- `docs/app/(home)/privacy/page.tsx`: names every host a visitor's browser
  contacts and every storage key the docs site writes. A new third-party
  request (script, font, image, embed) or storage key updates it, and
  `PRIVACY_UPDATED_AT` in `docs/lib/legal.ts`, in the same change.
