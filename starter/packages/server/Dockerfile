# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# Install all workspace deps (build stage is discarded)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @starter/shared run build
RUN pnpm --filter @starter/server run build
# `pnpm deploy --prod` bundles the production dependency closure into
# a self-contained directory at /prod. Crucial here: the workspace
# layout uses pnpm's symlinked node_modules (a `.pnpm/<pkg>@<ver>/...`
# central store + per-package symlink farms), so a plain
# `COPY --from=build /app/packages/server/node_modules ./node_modules`
# in the runtime stage drags dangling symlinks (the .pnpm store isn't
# copied). Deploy materialises the closure with real files + the
# workspace dependency (@starter/shared) inlined into node_modules/,
# so the runtime stage only needs the /prod tree. Requires the
# package's `dist/` to exist first — that's why the build steps above
# run before this one.
RUN pnpm --filter @starter/server --prod deploy /prod

# ── Stage 3: Production runtime ─────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# curl for Coolify's health check. Coolify probes the container by
# running `curl … || wget … || exit 1` INSIDE it, in place of the
# HEALTHCHECK below, and bookworm-slim ships neither. Without one the
# probe can never pass: every deploy would be rolled back and the old
# container kept. With it, a deploy is a rolling update — the old
# container serves until this one is healthy.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

# The git commit this image was built from, surfaced by /api/health so
# "is the deployed thing the thing I built?" is one HTTP request rather
# than an archaeology session. The deploy job polls that field until it
# matches the commit it just pushed — without it, a deploy that silently
# kept the previous container reported success on every status surface.
#
# Runtime env is enough here (unlike the client's NEXT_PUBLIC_*, which
# must be inlined at build time), so it lives in the runtime stage and
# costs no rebuild. Empty outside a CI image build, which is correct —
# a local `pnpm dev` has no commit it was built from.
ARG COMMIT_SHA
ENV COMMIT_SHA=$COMMIT_SHA

# Self-contained prod bundle from `pnpm deploy` — dist + package.json +
# node_modules (with @starter/shared materialised, no symlinks).
COPY --from=build /prod/dist ./dist
COPY --from=build /prod/package.json ./
COPY --from=build /prod/node_modules ./node_modules

# `.env.production` is deliberately NOT copied in.
#
# Runtime configuration comes from the container's environment, which
# Coolify populates (`hatchkit sync` pushes the resolved values there).
# The encrypted `.env.production` is the at-rest store that sync reads
# FROM on the developer's machine — it is not the runtime source.
#
# Two reasons it isn't the runtime source. It cannot cover the client
# half at all: Next.js inlines NEXT_PUBLIC_* into the browser bundle at
# image BUILD time, so those arrive as Docker build args and no runtime
# file can affect them. And shipping the ciphertext next to the key that
# decrypts it, in one image, buys little over just holding the values.
#
# src/config/env.ts still calls dotenvx and is guarded by an existsSync,
# so the absence of the file here is a no-op rather than a crash.

# Shutdown drain. Coolify deploys by starting the new container, waiting
# for it to turn healthy, then running `docker stop` on this one — and
# Traefik keeps routing here until the process has EXITED, so requests
# caught in between fail with a 502 or hang into a 504. On SIGTERM the
# server fails its health probe (so Docker marks this container unhealthy
# and Traefik drops it), keeps serving for SHUTDOWN_DRAIN_SECONDS, then
# shuts down — see the "Graceful shutdown" section of src/index.ts.
#
# SHUTDOWN_DRAIN_SECONDS is timed against the health check hatchkit sets
# on the Coolify app (every 2 s, 5 retries) and has to stay under the
# 30 s `docker stop` allows. 0 turns the drain off.
ENV SHUTDOWN_DRAIN_SECONDS=20

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
