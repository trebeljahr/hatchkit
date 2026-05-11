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
# No build-time secrets: the docs site reads nothing from .env, so
# the workflow's `dotenvx_private_key` BuildKit secret isn't mounted.
ARG NODE_VERSION=24

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
RUN pnpm build

FROM nginx:alpine AS runner
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 80
