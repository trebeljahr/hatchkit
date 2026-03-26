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
pnpm run dev                          # start server + client (random ports)
pnpm run dev:fixed                    # start on fixed ports (client=3000, server=5000)
```

## How to Test

```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run test:client                  # client unit tests (Vitest)
pnpm run test:e2e                     # Playwright E2E tests
pnpm run build                        # build all packages
```

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
