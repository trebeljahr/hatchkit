# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:24-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
# Install all workspace deps (build stage is discarded)
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client packages/client

# Next.js inlines NEXT_PUBLIC_* into the browser bundle at BUILD time —
# runtime env on the deployed container has no effect on browser code.
# CI passes these as --build-arg (see .github/workflows/build-and-deploy.yml).
# HATCHKIT_IMAGE_BUILD makes next.config.ts fail the build loudly when
# NEXT_PUBLIC_API_URL is missing, instead of baking a broken fallback.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_OPENPANEL_CLIENT_ID
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ARG NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_OPENPANEL_CLIENT_ID=$NEXT_PUBLIC_OPENPANEL_CLIENT_ID \
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN=$NEXT_PUBLIC_PLAUSIBLE_DOMAIN \
    NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL=$NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    HATCHKIT_IMAGE_BUILD=1

# The git commit this image was built from. Written next to the export as
# version.json (below) so the deployed artefact can be asked what it is —
# the deploy job polls it until it reports the commit CI just pushed.
ARG COMMIT_SHA
ENV COMMIT_SHA=$COMMIT_SHA

RUN pnpm --filter @starter/shared run build
RUN pnpm --filter @starter/client run build

# Prove the API URL actually reached the browser bundle, and fail the
# image if it did not.
#
# next.config.ts already refuses to build when NEXT_PUBLIC_API_URL is
# unset (HATCHKIT_IMAGE_BUILD=1 turns that guard on), which catches a
# missing build arg. This catches the case that guard cannot see: a value
# that IS set and still never gets inlined — a renamed variable, a
# reference that only exists in server code, an accidental runtime
# `process.env` lookup. Next.js inlines NEXT_PUBLIC_* at build time, so
# an image built that way builds perfectly, starts healthy, and talks to
# the wrong API — or to nothing at all.
RUN test -n "$NEXT_PUBLIC_API_URL" \
      || (echo "NEXT_PUBLIC_API_URL build arg is empty" >&2; exit 1); \
    grep -rqF "$NEXT_PUBLIC_API_URL" packages/client/.next/static \
      || (echo "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL never made it into the browser bundle" >&2; exit 1)

# Stamp the commit and the baked API origin next to the export. `public/`
# is copied into the runtime stage verbatim, so Next serves this as
# /version.json like any other static file. Two facts, because a correct
# commit can still carry the wrong API URL: the pipeline asserts both.
RUN printf '{"commit":"%s","apiUrl":"%s"}\n' "$COMMIT_SHA" "$NEXT_PUBLIC_API_URL" \
      > packages/client/public/version.json

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

# Next.js standalone output
COPY --from=build /app/packages/client/.next/standalone ./
COPY --from=build /app/packages/client/.next/static ./packages/client/.next/static
COPY --from=build /app/packages/client/public ./packages/client/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/client/server.js"]
