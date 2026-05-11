# syntax=docker/dockerfile:1
#
# Static-site image for hatchkit's docs (Docusaurus at docs/).
# Built by .github/workflows/deploy.yml, pushed to GHCR, pulled by
# Coolify for hatchkit.trebeljahr.com. nginx serves the prebuilt
# bundle — no runtime Node.
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
COPY docs/package.json docs/pnpm-lock.yaml docs/.npmrc ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY docs/ ./
RUN pnpm build

FROM nginx:alpine AS runner
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
