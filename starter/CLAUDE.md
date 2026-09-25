<!-- hatchkit:doc Blocks between a `hatchkit:if <cond>` marker and the matching -->
<!-- hatchkit:doc `hatchkit:endif` are pruned at scaffold time by -->
<!-- hatchkit:doc cli/src/scaffold/claude-md.ts. Markers also work inline, spanning part -->
<!-- hatchkit:doc of a line. Every hatchkit marker is stripped from generated projects, so -->
<!-- hatchkit:doc what ships is plain Markdown. Conditions: server, client, fullstack, -->
<!-- hatchkit:doc static, backend, newsletter, native, desktop, mobile, websocket, -->
<!-- hatchkit:doc stripe. -->

# node-realtime-starter

A stampable starter repo for multiplayer web games and SaaS apps. Express backend, Next.js frontend, MongoDB, tRPC, better-auth, Stripe, WebSocket support.

## Hatchkit Context

This starter is normally generated and maintained by `hatchkit`.
If `.hatchkit.json` exists at the project root, treat the repo as a
Hatchkit-managed project.

Useful Hatchkit commands from inside a generated project:

```bash
hatchkit overview --json                 # inspect manifest/project state
hatchkit update                          # add supported features additively
hatchkit add <project> [services]        # provision GlitchTip/OpenPanel/Plausible/Listmonk+SES/S3/email/search
hatchkit keys push <project>             # push dotenvx private key to Coolify/GitHub Actions
hatchkit sync                            # sync/deploy existing project state
hatchkit rename-domain                   # update domain-related deploy config
hatchkit regen-infra                     # regenerate infra/deploy files
hatchkit provision s3                    # create project buckets + env entries
hatchkit assets pull                     # mirror remote object storage assets locally
```

<!-- hatchkit:if newsletter -->
Newsletter / Listmonk + SES smoke commands (run from the project root
once `hatchkit add <project> listmonk-ses` has populated env):

```bash
pnpm newsletter:verify              # full smoke — API reach, list ids, subscriber, real tx send
pnpm newsletter:test-tx             # send one /api/tx email to LISTMONK_TEST_RECIPIENT
pnpm newsletter:welcome             # send emails/welcome.html to LISTMONK_TEST_RECIPIENT
pnpm newsletter:draft emails/digest-sample.html --subject "Issue 1"   # stage digest as a Listmonk draft
NODE_ENV=production pnpm newsletter:send emails/digest-sample.html --subject "..." --confirm   # real broadcast
```

Hatchkit auto-subscribes your default forwarding email onto
`<project>-test` and writes it to `.env.development` as
`LISTMONK_TEST_RECIPIENT`, so the smoke scripts work end-to-end on a
fresh provision with no extra setup.

<!-- hatchkit:endif -->
Before giving Hatchkit setup advice, run `hatchkit status --json` and
read `providers[]`, `nextStep`, and `suggestions[]`. For provider failures,
run `hatchkit doctor --json` and surface the failing `checks[].hint[]`
lines. Never print dotenvx private keys unless the user specifically asks.

If a Hatchkit command breaks in this project, report the failing command,
cwd, Hatchkit version, output, suspected source area, and safe undo path.
When asking another agent to fix it, include a repair prompt with those details
and tell it to preserve existing user setups, use `--dry-run` where possible,
and ask before provider/DNS/Coolify/Terraform/keychain mutations.

Do not run commands that may alter existing infrastructure unless the user
explicitly asks. Prefer giving the command to the user, or using preview modes
such as `hatchkit destroy <project> --recipe`, `hatchkit gh-pages --undo
--dry-run`, and other command-specific `--dry-run` options.

## Tech Stack

<!-- hatchkit:if server -->
- **Backend:** Express + TypeScript, tRPC for typed API, better-auth for authentication<!-- hatchkit:if stripe -->, Stripe for payments<!-- hatchkit:endif -->
<!-- hatchkit:endif -->
<!-- hatchkit:if fullstack -->
- **Frontend:** Next.js (App Router) + Tailwind CSS + shadcn/ui, tRPC React Query client
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
- **Frontend:** Next.js (App Router) + Tailwind CSS + shadcn/ui
<!-- hatchkit:endif -->
<!-- hatchkit:if server -->
- **Database:** MongoDB (Mongoose) + Redis (ioredis)
<!-- hatchkit:endif -->
<!-- hatchkit:if websocket -->
- **Real-time:** Native `ws` WebSocket on same Express process
<!-- hatchkit:endif -->
<!-- hatchkit:if fullstack -->
- **Monorepo:** pnpm workspaces — `packages/server`, `packages/client`, `packages/shared`
<!-- hatchkit:endif -->
<!-- hatchkit:if backend -->
- **Monorepo:** pnpm workspaces — `packages/server`, `packages/shared`
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
- **Monorepo:** pnpm workspaces — `packages/client`, `packages/shared`
<!-- hatchkit:endif -->

## How to Run

<!-- hatchkit:if server -->
```bash
pnpm install                          # install all dependencies
pnpm run dev:infra                    # start MongoDB, Redis, local S3 (Docker, one-time)
pnpm run seed:assets                  # populate local S3 from seed/assets/ (idempotent)
pnpm run dev                          # start server + client (random ports)
pnpm run dev:fixed                    # start on fixed ports (client=3000, server=5000)
```

Drop fixtures into `seed/assets/` to have them auto-populate the
local bucket — see `seed/README.md`. To copy a real-prod bucket into
local for realistic dev data, `hatchkit assets pull` (treat the copy
as production data — same handling rules apply).
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
```bash
pnpm install                          # install all dependencies
pnpm run dev                          # start the Next.js client
pnpm run build                        # production build
```
<!-- hatchkit:endif -->

## How to Test

<!-- hatchkit:if fullstack -->
```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run test:client                  # client unit tests (Vitest)
pnpm run test:e2e                     # Playwright E2E tests
pnpm run build                        # build all packages
```
<!-- hatchkit:endif -->
<!-- hatchkit:if backend -->
```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run build                        # build all packages
```
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
```bash
pnpm run test:client                  # client unit tests (Vitest)
pnpm run build                        # build all packages
```
<!-- hatchkit:endif -->

<!-- hatchkit:if native -->
## Native Shells

All native targets wrap the Next.js client as a **static export** (`output: "export"`).
<!-- hatchkit:if server -->
The Express server is always remote — the client talks to it over HTTPS.
<!-- hatchkit:endif -->

<!-- hatchkit:if desktop -->
### Desktop (Electron)

```bash
pnpm dev:desktop                      # Next dev + Electron window, HMR recovery
pnpm build:desktop                    # static export + compile electron/
pnpm electron:build                   # electron-builder → dmg/zip/exe/AppImage
pnpm icons:desktop                    # regenerate icns/ico/png set (electron-icon-builder; cross-platform)
```

Replace `build/icon.png` with a 512×512 logo before shipping.
Bundle config lives in root `package.json` `"build"` (electron-builder).
Electron IPC bridge: `electron/preload.ts` exposes `window.electronAPI`.
<!-- hatchkit:endif -->


<!-- hatchkit:if mobile -->
### Mobile

```bash
pnpm cap:add:ios                      # one-time — requires Xcode
pnpm cap:add:android                  # one-time — requires Android Studio / SDK
pnpm dev:ios                          # live-reload on Simulator
pnpm dev:android                      # live-reload on emulator/device
pnpm build:mobile                     # static export + cap sync
pnpm mobile:assets                    # generate icons/splash from resources/
pnpm build:android:release            # AAB for Play Store
pnpm build:ios:release                # opens Xcode for App Store archive
```

Bridge runs in `packages/client/src/mobile/bridge.ts` — lifecycle, splash,
status bar, orientation. Durable persistence mirror in `durable.ts`.
<!-- hatchkit:endif -->

<!-- hatchkit:if server -->
### Native client auth

Better-auth uses cookies; native shells need extra CORS/trust origins.
Set `TRUSTED_ORIGINS` on the server (comma-separated):

```
TRUSTED_ORIGINS=capacitor://localhost,https://localhost
```

<!-- hatchkit:if desktop -->
Electron `file://` sends `Origin: null` and can't be trusted with
credentials. Register a custom protocol in `electron/main.ts` and add
it (e.g. `app://-`) instead.
<!-- hatchkit:endif -->

<!-- hatchkit:endif -->

### Static export caveats

<!-- hatchkit:if server -->
- `NEXT_PUBLIC_API_URL` is baked at build time — desktop/mobile binaries
  are locked to whichever API URL they were built against. Rebuild to
  retarget.
<!-- hatchkit:endif -->
- No `rewrites()`, no `middleware.ts`, no server components with runtime
  data. Dynamic routes need `generateStaticParams`.
- Next `<Image>` uses the default loader only because `images.unoptimized`
  is set in `next.config.ts`.
<!-- hatchkit:endif -->

<!-- hatchkit:if workspaces -->
## Workspaces, members and invitations

Membership changes go through the app's own API only — `workspaces`,
`members` and `invitations`, one line each over `services/membership/`.
better-auth's organization plugin stays installed for its tables
(`organization`, `member`, `invitation`, the session's
`activeOrganizationId`) and for the server-side `auth.api.createOrganization`
the signup hook calls, but **every `/api/auth/organization/*` request that
arrives over HTTP answers 404** (`auth/organization-lockdown.ts`, wired as
the instance's one `hooks.before`). Those endpoints write `member` and never
`WorkspaceMember`, and they accept roles this app's rules refuse — each one
was a way around the rules below. `tests/organization-http-lockdown.test.ts`
hits all of them against the real library.

Six rules, each of which fails quietly if broken:

- **The mirror grants access; it is written last and deleted first.** The app
  authorizes from `WorkspaceMember` alone. Add writes `member` then the
  mirror; remove deletes the mirror then `member`. A crash in between always
  leaves less access, and re-running the operation finishes it. Remove and
  leave keep the person's own records.
- **Never zero owners.** Transfer promotes the target in both records first,
  then demotes the previous owner — `member` before the mirror, so somebody
  who retries a half-finished transfer is still an owner. The last owner
  cannot leave, be demoted or removed while anybody else remains; the sole
  member cannot leave at all. `tests/membership-lifecycle.test.ts` fails
  every write in turn.
- **Roles are exactly `owner|admin|member`; flags follow the role.** An
  owner's two visibility flags are forced on; everybody else, invited admins
  included, starts closed; a role change never grants a flag. Owner is
  reachable only by transfer — never by invitation or a role update. A stored
  unrecognised role reads as `member`.
- **Foreign ids are NOT_FOUND before any permission is consulted.** Every
  member/invitation lookup carries the actor's `workspaceId` in the query;
  only a real row of the caller's own workspace can earn FORBIDDEN, whose
  message is a stable code from `MEMBERSHIP_REFUSALS`. The matrix is in
  `services/membership/permissions.ts` and
  `tests/members-permissions.test.ts`.
- **Accepting an invitation needs the invited email, not a verified one.**
  The proof is possession of the id — 96 CSPRNG bits, never an adapter
  ObjectId, which is guessable — delivered to that inbox, or handed over by
  the inviter from the link the UI shows when no mail transport is
  configured. Requiring verification would make invitations unusable on
  exactly the self-hosted instances with no mail to verify with. The
  case-insensitive email match is what stops a forwarded link being accepted
  under somebody else's account, and it is checked before the status, so a
  wrong account learns nothing about whether the link is live. The link is
  `${FRONTEND_URL}/invite/?id=<id>` — a query parameter, because a static
  export cannot serve `/invite/<id>`.
- **An explicit `workspaceId` never falls back; a stale session default
  does.** A request naming a workspace the caller is not in is NOT_FOUND — a
  replayed offline row must never land in another workspace. A session whose
  `activeOrganizationId` points at a workspace the person left falls back to
  their oldest membership. `workspaces.setActive` writes the session row,
  which the five-minute cookie cache can hide for that long; first-party
  clients therefore send `workspaceId` explicitly, and every
  `workspaceProcedure` takes an object input that allows it
  (`tests/workspace-resolution.test.ts` walks the router).

Invitations are rows in better-auth's `invitation` collection with the
plugin's field names, so account deletion's invitation cleanup covers them.
A re-invite of a pending address refreshes and re-sends the same row; a
workspace holds at most 50 pending, and an inviter sends at most 20 per hour
(Redis when present, per process otherwise). With no transport, or a failed
send, the invitation is kept, the URL is logged, and `emailSent: false` tells
the inviter to share the link.

### Members screen, invite page and visibility

- **`/invite` lives outside the protected tree and reads a query
  parameter.** Under a protected layout a signed-out invitee is bounced to
  /login before the page can say whose workspace invited them, and an
  `/invite/[id]` segment 404s under `output: "export"`.
- **`?next=` goes through `lib/safe-next.ts` and nothing else.** It accepts
  only a single-`/` path with no backslash, whitespace or control character,
  still on this origin after URL parsing, under an allowlisted prefix. The
  login page is the one everybody trusts, which makes an unvalidated `next` a
  phishing redirect.
- **Switching workspaces is a full page load** (`enterWorkspace`). A
  client-side route change keeps every cached query and socket built for the
  previous workspace's permissions. Anything cached is keyed by workspace.
  The screens' own workspace is the switcher's active id, not the session
  default — otherwise Members manages one workspace while requests address
  another.
- **Cross-member visibility is decided server side**, projected where that is
  honest and refused where it is not. A withheld sensitive slot is `null`,
  never `0`. An aggregate withholds every sensitive figure rather than a
  partial sum and says so.<!-- hatchkit:if websocket --> The sync fan-out is
  per recipient: `ws/membership-sync.ts` reads memberships fresh on every
  publish and projects the event for each member. A new event kind that
  carries a record must be added to its switch.<!-- hatchkit:endif -->

The screens call the app's own typed API only — never
`authClient.organization.*`, whose HTTP endpoints answer 404.
<!-- hatchkit:endif -->

<!-- hatchkit:if server -->
## Environment & Secrets (dotenvx)

The server uses **[dotenvx](https://dotenvx.com)** for env handling — a
drop-in replacement for `dotenv` that transparently decrypts values
marked `encrypted:...`. `packages/server/src/config/env.ts` loads
either `.env.production` (when `NODE_ENV=production`) or
`.env.development` (otherwise).

```
packages/server/
  .env.example        plaintext, committed (reference, no real secrets)
  .env.development    plaintext, committed (local-dev defaults, localhost)
  .env.production     mixed: plaintext config + encrypted secrets,
                      committed to git. Public key lives at the top.
  .env.keys           DOTENV_PRIVATE_KEY_PRODUCTION lives here locally;
                      gitignored. In production, set it as an env var
                      instead.
```

### Setting an encrypted value

```bash
pnpm --filter @starter/server exec dotenvx set STRIPE_SECRET_KEY sk_live_... -f .env.production
```

Writes the encrypted ciphertext into `.env.production` and appends
the private key to `.env.keys` if it wasn't there already.

### Running locally against production values

`.env.keys` is read automatically — no extra step:
```bash
NODE_ENV=production pnpm --filter @starter/server start
```

### Deploying to Coolify

Two roles, easy to conflate:

- **`.env.production` (encrypted, committed) is the at-rest store.**
  `hatchkit secrets rotate` writes into it and `hatchkit sync` reads it.
  Committing it is what keeps the values off a single laptop.
- **Coolify's environment is the runtime source of truth.** `hatchkit
  sync` decrypts the at-rest store locally and pushes the resolved
  values into Coolify's env fields, which is where the running
  container reads them from. `docker-compose.yml` declares each one as
  `${VAR}`, which is what makes Coolify render a field per value.

The encrypted file is **not** shipped into the image — the server
Dockerfile deliberately does not copy it. It could never cover the
client half anyway (`NEXT_PUBLIC_*` are inlined into the browser bundle
at image *build* time and arrive as Docker build args), and pairing
ciphertext with its own decryption key in one image buys little.

`config/env.ts` still calls dotenvx behind an `existsSync` guard, so in
a deployed container the call is a no-op and `process.env` already holds
everything. That guard is why the same file works locally, in CI, and in
production.

Note for machines with a global git ignore: the usual
`~/.config/git/ignore` lists `.env.production`, and a repo `.gitignore`
only overrides a global pattern when it has one of its own — omitting
the file is not enough. This repo's `.gitignore` carries an explicit
`!.env.production` negation for exactly that reason. `hatchkit doctor`
fails if the encrypted file ends up uncommitted anyway.

### Key rotation

```bash
pnpm --filter @starter/server exec dotenvx rotate -f .env.production
# Then `hatchkit sync` to push the re-encrypted values to Coolify.
```

Keep `.env.keys` out of commits. `.gitignore` enforces this.
<!-- hatchkit:endif -->

## Code Style

- TypeScript strict mode everywhere. No `any` — use `unknown` and narrow.
- Prefer `const` over `let`. Never use `var`.
- Named exports only (no default exports except Next.js pages which require them).
- Explicit return types on all public/exported functions.
<!-- hatchkit:if fullstack -->
- Use `@starter/shared` for types shared between client and server.
<!-- hatchkit:endif -->
<!-- hatchkit:if client -->
- Use `@/` path alias for client-side imports within the client package.
<!-- hatchkit:endif -->

## File Organization

<!-- hatchkit:if server -->
```
packages/server/src/
  config/       — environment variables, app config
  db/           — database connections (mongoose, redis)
  models/       — Mongoose schemas and models
  auth/         — better-auth instance and config
  trpc/         — tRPC router, context, procedures
    routers/    — individual tRPC routers (one per domain)
  ws/           — WebSocket handler, room manager, auth
  services/     — external service integrations (Stripe, email, S3)
  middleware/   — Express middleware (error handler, etc.)
  tests/        — server unit tests
```
<!-- hatchkit:endif -->

<!-- hatchkit:if fullstack -->
```
packages/client/src/
  app/          — Next.js App Router pages
  lib/          — tRPC client, auth client, utilities
  providers/    — React context providers
  hooks/        — custom React hooks
  components/   — React components
    ui/         — shadcn/ui components
  styles/       — global CSS
```
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
```
packages/client/src/
  app/          — Next.js App Router pages
  lib/          — utilities
  components/   — React components
    ui/         — shadcn/ui components
  styles/       — global CSS
```
<!-- hatchkit:endif -->

```
packages/shared/src/
  protocol.ts   — WebSocket message types (discriminated unions)
  types.ts      — shared domain types
  schemas.ts    — Zod validation schemas
```

<!-- hatchkit:if server -->
## Critical Middleware Ordering (Express)

The order in `app.ts` is load-bearing. Do not rearrange:

1. `cors()` — CORS with credentials, before every route so preflight succeeds
1. `better-auth` handler at `/api/auth/*` — BEFORE express.json (it handles its own body parsing)
<!-- hatchkit:if stripe -->
1. Stripe webhook at `/api/stripe/webhook` with `express.raw()` — needs raw body for signature verification
<!-- hatchkit:endif -->
1. `express.json()` + `express.urlencoded()` — JSON parsing for everything else
1. `helmet()` + `morgan()` — security headers and HTTP logging
1. tRPC middleware at `/api/trpc`
1. Health endpoint at `/api/health`
1. Error handlers (404 + 500) — must be last

## Environment Variables

- Always add new env vars to `.env.example` with a comment explaining the value
- Add sensible dev defaults to `.env.development` (this file is committed)
- Never commit `.env` or `.env.local` (these are gitignored)
<!-- hatchkit:if server -->
- Server env vars: plain `process.env.X` via `config/env.ts`
<!-- hatchkit:endif -->
<!-- hatchkit:if client -->
- Client env vars: must be prefixed with `NEXT_PUBLIC_` to be available in the browser
<!-- hatchkit:endif -->

## Testing Conventions

<!-- hatchkit:if server -->
- **Server unit tests:** `node:test` module + `assert/strict`. Files in `packages/server/src/tests/*.test.ts`.
<!-- hatchkit:endif -->
<!-- hatchkit:if client -->
- **Client unit tests:** Vitest + @testing-library/react. Files colocated as `*.test.tsx`.
<!-- hatchkit:endif -->
<!-- hatchkit:if fullstack -->
- **E2E tests:** Playwright. Files in `e2e/*.spec.ts`. Helpers in `e2e/helpers.ts`.
- Use `data-testid` attributes for E2E selectors, not CSS classes or text content.
<!-- hatchkit:endif -->

## Commit Messages

Use conventional style: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
Keep the first line under 72 characters. Add a blank line before any body text.

## Branch Naming

`feat/description`, `fix/description`, `refactor/description`.
