FROM node:24-alpine
WORKDIR /app
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bridge ./bridge
COPY relay/message.mjs ./relay/message.mjs
USER node
CMD ["node", "bridge/server.mjs"]
