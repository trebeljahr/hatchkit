# node-realtime-starter

A stampable starter repo for multiplayer web games and SaaS apps. Express backend, Next.js frontend, MongoDB, tRPC, better-auth, Stripe, WebSocket support.

## Tech Stack

- **Backend:** Express + TypeScript, tRPC for typed API, better-auth for authentication, Stripe for payments
- **Frontend:** Next.js (App Router) + Tailwind CSS + shadcn/ui, tRPC React Query client
- **Database:** MongoDB (Mongoose) + Redis (ioredis)
- **Real-time:** Native `ws` WebSocket on same Express process
- **Monorepo:** pnpm workspaces — `packages/server`, `packages/client`, `packages/shared`

## How to Run

```bash
pnpm install                          # install all dependencies
pnpm run dev:infra                    # start MongoDB, Redis, MinIO (Docker, one-time)
pnpm run seed:assets                  # populate local MinIO from seed/assets/ (idempotent)
pnpm run dev                          # start server + client (random ports)
pnpm run dev:fixed                    # start on fixed ports (client=3000, server=5000)
```

Drop fixtures into `seed/assets/` to have them auto-populate the
local bucket — see `seed/README.md`. To copy a real-prod bucket into
local for realistic dev data, `hatchkit assets pull` (treat the copy
as production data — same handling rules apply).

## How to Test

```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run test:client                  # client unit tests (Vitest)
pnpm run test:e2e                     # Playwright E2E tests
pnpm run build                        # build all packages
```

## Desktop (Electron) + Mobile (Capacitor)

Both targets wrap the Next.js client as a **static export** (`output: "export"`).
The Express server is always remote — the client talks to it over HTTPS.

### Desktop

```bash
pnpm dev:desktop                      # Next dev + Electron window, HMR recovery
pnpm build:desktop                    # static export + compile electron/
pnpm electron:build                   # electron-builder → dmg/zip/exe/AppImage
pnpm icons:desktop                    # regenerate icns/ico/png set (electron-icon-builder; cross-platform)
```

Replace `build/icon.png` with a 512×512 logo before shipping.
Bundle config lives in root `package.json` `"build"` (electron-builder).
Electron IPC bridge: `electron/preload.ts` exposes `window.electronAPI`.

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

### Native client auth

Better-auth uses cookies; native shells need extra CORS/trust origins.
Set `TRUSTED_ORIGINS` on the server (comma-separated):

```
TRUSTED_ORIGINS=capacitor://localhost,https://localhost
```

Electron `file://` sends `Origin: null` and can't be trusted with
credentials. Register a custom protocol in `electron/main.ts` and add
it (e.g. `app://-`) instead.

### Static export caveats

- `NEXT_PUBLIC_API_URL` is baked at build time — desktop/mobile binaries
  are locked to whichever API URL they were built against. Rebuild to
  retarget.
- No `rewrites()`, no `middleware.ts`, no server components with runtime
  data. Dynamic routes need `generateStaticParams`.
- Next `<Image>` uses the default loader only because `images.unoptimized`
  is set in `next.config.ts`.

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

The CLI's `devops-cli create` (with `runDeployment: true`) pushes
`DOTENV_PRIVATE_KEY_PRODUCTION` to Coolify's env for you. The
encrypted `.env.production` ships with the repo; Coolify injects the
key at runtime and dotenvx decrypts on load.

### Key rotation

```bash
pnpm --filter @starter/server exec dotenvx rotate -f .env.production
# Then re-deploy so Coolify picks up the new private key.
```

Keep `.env.keys` out of commits. `.gitignore` enforces this.

## Code Style

- TypeScript strict mode everywhere. No `any` — use `unknown` and narrow.
- Prefer `const` over `let`. Never use `var`.
- Named exports only (no default exports except Next.js pages which require them).
- Explicit return types on all public/exported functions.
- Use `@starter/shared` for types shared between client and server.
- Use `@/` path alias for client-side imports within the client package.

## File Organization

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

packages/client/src/
  app/          — Next.js App Router pages
  lib/          — tRPC client, auth client, utilities
  providers/    — React context providers
  hooks/        — custom React hooks
  components/   — React components
    ui/         — shadcn/ui components
  styles/       — global CSS

packages/shared/src/
  protocol.ts   — WebSocket message types (discriminated unions)
  types.ts      — shared domain types
  schemas.ts    — Zod validation schemas
```

## Critical Middleware Ordering (Express)

The order in `app.ts` is load-bearing. Do not rearrange:

1. `better-auth` handler at `/api/auth/*` — BEFORE express.json (it handles its own body parsing)
2. Stripe webhook at `/api/stripe/webhook` with `express.raw()` — needs raw body for signature verification
3. `express.json()` + `express.urlencoded()` — JSON parsing for everything else
4. `helmet()` — security headers
5. `cors()` — CORS with credentials
6. `morgan()` — HTTP logging
7. tRPC middleware at `/api/trpc`
8. Health endpoint at `/api/health`
9. Error handlers (404 + 500) — must be last

## Environment Variables

- Always add new env vars to `.env.example` with a comment explaining the value
- Add sensible dev defaults to `.env.development` (this file is committed)
- Never commit `.env` or `.env.local` (these are gitignored)
- Server env vars: plain `process.env.X` via `config/env.ts`
- Client env vars: must be prefixed with `NEXT_PUBLIC_` to be available in the browser

## Testing Conventions

- **Server unit tests:** `node:test` module + `assert/strict`. Files in `packages/server/src/tests/*.test.ts`.
- **Client unit tests:** Vitest + @testing-library/react. Files colocated as `*.test.tsx`.
- **E2E tests:** Playwright. Files in `e2e/*.spec.ts`. Helpers in `e2e/helpers.ts`.
- Use `data-testid` attributes for E2E selectors, not CSS classes or text content.

## Commit Messages

Use conventional style: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
Keep the first line under 72 characters. Add a blank line before any body text.

## Branch Naming

`feat/description`, `fix/description`, `refactor/description`.
