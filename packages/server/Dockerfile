# ── Stage 1: Install dependencies ────────────────────────────────────
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @starter/server --filter @starter/shared

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @starter/shared run build
RUN pnpm --filter @starter/server run build

# ── Stage 3: Production runtime ─────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
RUN corepack enable
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy built output and production dependencies
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/server/package.json ./
COPY --from=build /app/packages/server/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./node_modules/@starter/shared/dist
COPY --from=build /app/packages/shared/package.json ./node_modules/@starter/shared/

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
