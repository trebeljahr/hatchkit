# Starter Repo & Game Server Architecture Research

Reference document from the 2026-03-26 brainstorming session. Covers technology choices, performance data, and architectural decisions for building stampable multiplayer web games with SaaS features.

## The Goal

Build a reusable starter repo for multiplayer web games with:
- Express + TypeScript backend (no framework wrappers)
- Vite + React + Tailwind frontend
- Auth (email/password, OAuth, guest accounts)
- Stripe payments (subscriptions + one-time purchases for in-game cosmetics)
- Transactional email (Mailgun — signup, password reset)
- WebSocket real-time (native `ws` or Socket.IO)
- PostgreSQL for relational data (users, purchases, leaderboards)
- Redis for ephemeral game state and pub/sub
- Error tracking (GlitchTip, Sentry SDK-compatible)
- Analytics (Plausible script tag)
- Dockerfile + GitHub Actions CI/CD → Coolify deployment

Keep the infra automation (this repo) separate from the app starter. Different lifecycles, different audiences.

## Framework Decision: Express (not Wasp, not NestJS)

### Why Express

- Most AI training data of any Node.js framework — Claude/Copilot generate correct code nearly every time
- Full control over every middleware, route, and handler — no compiler intermediary
- Years of existing experience and mental model
- The Tiao app already runs on Express — patterns carry over
- Performance is identical to Wasp at runtime (Wasp compiles down to Express)

### Why not Wasp / Open SaaS

Wasp is a Haskell compiler that reads a `.wasp` DSL file and generates Express + React + Prisma code. At runtime it IS Express — zero overhead. Open SaaS (built on Wasp) provides auth, Stripe, email, admin dashboard, Socket.IO, and AI agent tooling out of the box.

**What's good:**
- Massive boilerplate reduction (auth, Stripe, email in a few DSL lines)
- WebSocket support via Socket.IO (full io:Server access, rooms, binary, typed events)
- Coolify deployment is documented and works
- Can connect Redis/MongoDB alongside PostgreSQL via `setupFn` escape hatch
- Best AI agent integration of any framework (Claude Code plugin, llms.txt)

**Why we passed:**
- Generated code lives in `.wasp/out/` — not yours, overwritten on every build
- No formal eject command — coupled to the compiler during development
- The DSL is another layer of abstraction that hides what's happening
- When you need something Wasp doesn't support, you use escape hatches that feel like workarounds
- Debugging goes through generated code, not code you wrote
- For someone who wants to understand and control their stack, the indirection is a real cost

**Bottom line:** Wasp solves "I don't want to wire up boilerplate." If you're comfortable doing that yourself (and you are), it's just indirection.

### Why not NestJS

- Decorator-heavy ceremony (modules, controllers, services, DTOs for every endpoint)
- When AI generates NestJS code with a wrong decorator or missing module import, the DI errors are cryptic
- Absent from the open-source SaaS starter ecosystem — too heavy for "get started fast"
- Excellent for 5+ person teams where enforced consistency matters; overhead for a solo dev

### Why not Hono / Elysia

- Too new, limited AI training data — agents frequently produce incorrect code
- Ecosystem depth lacking for full SaaS features (background jobs, email, etc.)

## Database Decision: PostgreSQL (new projects) + MongoDB (game state where it fits)

The Node.js SaaS ecosystem has consolidated around PostgreSQL + Prisma. MongoDB is still great for document-heavy data (game replays, flexible schemas) but for users, subscriptions, teams, and billing — relational data — Postgres is what everything is built for.

**Approach:** PostgreSQL for new SaaS projects. MongoDB available via manual client for game-state-heavy things. They can coexist in the same app.

## Auth Decision: better-auth (likely) or hand-rolled

### better-auth

Open-source auth framework. Auth.js (NextAuth) team joined in Sept 2025 — it's the recommended successor.

**What it gives you:** email/password, 40+ OAuth providers, sessions, email verification, password reset, 2FA, passkeys, magic links, organization/team management, Stripe integration plugin.

**MongoDB support:** Yes, via native driver adapter (not Mongoose). Creates its own collections.

**Express support:** Yes, but secondary target. `express.json()` must be mounted AFTER the better-auth handler.

**Gotchas:**
- No Mongoose adapter — two data access patterns coexist if your app uses Mongoose
- Custom user fields limited to basic types (string, number, boolean)
- Express is second-class citizen in docs and community examples
- Stripe plugin is comprehensive (auto customer creation, subscription lifecycle, trial abuse prevention, per-seat pricing)

### Hand-rolled auth

- Full Mongoose schema control
- JWT access+refresh tokens (stateless)
- bcrypt password hashing
- Mailgun for email (you wire it up either way)
- Custom middleware patterns you already know
- Cost: no OAuth (weeks per provider), no 2FA/passkeys (months), no Stripe integration (custom)

**Decision:** If the app needs OAuth or Stripe billing, use better-auth. For simple email/password only, hand-roll it.

## Real-Time Architecture

### For turn-based games (Tiao, chess, board games)

Express + native `ws` (or Socket.IO) is sufficient. Validate moves server-side, broadcast the result. State changes happen every few seconds — no tick loop needed.

### For real-time action games (asteroids, physics)

Implement Colyseus-like patterns directly in your Socket.IO/ws handlers:
- Server-authoritative tick loop (`setInterval` at fixed rate)
- Binary state serialization (MessagePack or custom)
- Room lifecycle (create, join, leave, reconnect, dispose)
- Delta state compression (only send what changed)
- Reconnection with tokens

### What naive Socket.IO lacks vs dedicated game servers

| Feature | Naive approach | What to add |
|---------|---------------|-------------|
| Matchmaking | Manual (share link) | Queue with skill-based matching |
| Game loop | Events processed as-arrived | Fixed tick rate, server validates all |
| Reconnection | Ad-hoc disconnect handler | Token-based rejoin within timeout |
| State sync | JSON broadcast entire state | Delta-compressed binary diffs |
| Scaling | Single process | Redis pub/sub for cross-instance |

### Dedicated game server frameworks (for reference, not using)

**Colyseus** (Node.js/TypeScript native):
- Automatic state sync (schema-based, binary delta-compressed)
- Room lifecycle hooks, built-in matchmaking, reconnection tokens
- Full npm access, standard async/await
- ~10K CCU capacity, scales with Redis
- MIT license. Used by: Pixels.xyz, Bloxd.io, Kirka.io

**Nakama** (Go-based):
- TypeScript runtime is NOT Node.js (Goja ES5 sandbox, no npm, no async/await)
- Breaks "shared code across the stack" goal
- 20K CCU on 3GB RAM, scales to 2M CCU (Enterprise)
- Overkill for turn-based games
- Used by: Remedy, Paradox, Zynga

## Performance: Does Language Choice Matter?

### At <10,000 concurrent users: No.

| Metric | Express (Node.js) | Go | Rust |
|--------|-------------------|-----|------|
| HTTP req/s | ~20K | ~200-400K | ~500K-1M+ |
| Memory per WS connection | ~3 KB (ws) / ~15 KB (Socket.IO) | ~20 KB | ~2-5 KB |
| Baseline memory | 30-80 MB | ~5 MB | 12-20 MB |
| Max WS on 4GB VPS | ~50-100K | ~50-175K | ~200-500K |

10K connections x 15 KB (Socket.IO) = 150 MB. A turn-based game at 1 msg/sec/game = 10K msg/sec. Express handles 20K req/s. You're at 50% capacity on a $5/month VPS.

**The bottleneck at this scale is developer productivity, feature velocity, and database design — not framework throughput.**

### Lichess architecture (for perspective)

- 147K peak concurrent users on ONE machine (96 cores, 192 GB RAM)
- Scala 3 / Play Framework (not the fastest language)
- Separate WebSocket service (lila-ws) communicating via Redis
- MongoDB for 4.7+ billion games
- Architecture and game logic matter more than raw language performance

### When it starts to matter

- 50K+ concurrent: Node.js event loop latency starts increasing
- 100K+ concurrent: memory becomes a real constraint
- At that point: extract the game loop into a Go/Rust service. Don't pre-optimize.

## External Services Checklist

### Shared (set up once, reuse across projects)

| Service | Purpose | Cost |
|---------|---------|------|
| Hetzner Cloud | VPS hosting | Pay-as-you-go (~5-15 EUR/mo) |
| Hetzner Object Storage | S3-compatible file storage | 4.99 EUR/mo for 1 TB |
| INWX | Domain DNS | Per-domain pricing |
| GitHub | Code + CI/CD | Free |
| GlitchTip | Error tracking (Sentry SDK-compatible) | Self-hosted, free |
| Plausible | Web analytics | $9/mo hosted, or self-host |

### Per-project

| Service | Purpose | Cost |
|---------|---------|------|
| Stripe | Payments (subscriptions + one-time) | Free until you charge |
| Mailgun | Transactional email | Flex: first 1K emails free |
| Coolify | Deployment control plane | Self-hosted on VPS |

## Infra Automation (this repo)

The `dev-ops-automation` repo handles:
- **Terraform:** Hetzner server + INWX DNS + S3 bucket creation
- **Ansible:** Server hardening (SSH, fail2ban, swap, Tailscale)
- **Coolify API script:** Creates app + databases + env vars + GitHub secrets
- **Stampable:** Copy templates, fill in values, `make tf-apply && make coolify-setup`

The app starter repo is separate — different lifecycle, different concerns.

## Open Questions for Future

- Exact starter repo structure (monorepo? separate client/server?)
- better-auth vs hand-rolled decision per project
- Colyseus patterns to extract for the real-time game template
- Shared services VPS (GlitchTip + Plausible + Uptime Kuma) — when to set up
- Mailgun DNS records (SPF, DKIM) in Terraform automation
