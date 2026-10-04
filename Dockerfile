# syntax=docker/dockerfile:1
#
# Static-site image for hatchkit's docs (Next.js + fumadocs at docs/).
# Built by .github/workflows/deploy.yml, pushed to GHCR, pulled by
# Coolify for hatchkit.trebeljahr.com. nginx serves the prebuilt
# bundle — no runtime Node. `next build` with `output: "export"`
# emits a fully static site to /app/out.
#
# docs/ is intentionally outside the root pnpm-workspace.yaml (which
# only covers cli/ + mcp/). docs/.npmrc sets `ignore-workspace=true`
# and carries its own lockfile so a docs deploy doesn't drag in the
# CLI's dev deps. We mirror that here: install + build inside docs/
# as a standalone project.
#
# No build-time secrets: the docs site reads nothing from .env.
ARG NODE_VERSION=24
ARG PREVIOUS_IMAGE

FROM ${PREVIOUS_IMAGE} AS previous

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
# Copy lockfile + .npmrc first so `pnpm install` lands in its own
# layer and caches across source-only changes. .npmrc is the file
# that flips `ignore-workspace=true`, so it MUST be present before
# the install step — otherwise pnpm walks up looking for the parent
# workspace and fails on the missing `cli/`/`mcp/` packages.
# next.config.mjs + source.config.ts must also be present pre-install:
# fumadocs-mdx's postinstall bin probes for `next.config.*` to choose
# between its Next.js and Vite codepaths. Without next.config.mjs the
# bin imports the Vite loader and crashes with ERR_MODULE_NOT_FOUND on
# the missing peer; without source.config.ts the Next codepath then
# fails esbuild because it can't externalise the missing entry.
COPY docs/package.json docs/pnpm-lock.yaml docs/.npmrc docs/next.config.mjs docs/source.config.ts ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY docs/ ./
ARG RELEASE_SHA
ENV NEXT_PUBLIC_BUILD_COMMIT=${RELEASE_SHA}
RUN pnpm build
COPY scripts/write-version.mjs /tmp/write-version.mjs
RUN node /tmp/write-version.mjs out "$RELEASE_SHA"
COPY --from=previous /usr/share/nginx/html /previous-export
COPY scripts/retain-docs-releases.mjs /tmp/retain-docs-releases.mjs
ARG PREVIOUS_SHA
ARG PREVIOUS_DIGEST
RUN node /tmp/retain-docs-releases.mjs out /previous-export /retained-out "$RELEASE_SHA" "$PREVIOUS_SHA" "$PREVIOUS_DIGEST"

FROM nginx:alpine AS runner
# Maps `/docs/<page>` onto the export's `<page>.html`. The stock config
# 403s every docs page — see the header of docs/nginx.conf.
COPY docs/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /retained-out /usr/share/nginx/html
ARG PREVIOUS_SHA
ARG PREVIOUS_DIGEST
LABEL io.hatchkit.docs.parent-sha=$PREVIOUS_SHA \
      io.hatchkit.docs.parent-digest=$PREVIOUS_DIGEST \
      io.hatchkit.docs.retention="3"
COPY --chmod=755 docs/drain-entrypoint.sh /usr/local/bin/drain-entrypoint
ENV SHUTDOWN_DRAIN_SECONDS=20
# nginx:alpine defaults to SIGQUIT. Our PID 1 must receive TERM first so
# loopback readiness can fail before nginx starts its graceful shutdown.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=2s --timeout=5s --start-period=15s --retries=5 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:80/ || exit 1
ENTRYPOINT ["/usr/local/bin/drain-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
EXPOSE 80
