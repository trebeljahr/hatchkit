# Linux smoke image for Electron apps (scripts/crossplat/README.md).
#
# What an unpacked electron-builder Linux build needs to start and paint under
# a virtual display, plus playwright-core to drive it over CDP. No browser is
# downloaded: the probe connects to the app's own Chromium.
#
# Project-agnostic on purpose: nothing here names an app. Build it for the
# Docker host's architecture; the runner refuses an app built for another one.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb xauth dbus dbus-x11 \
    libgtk-3-0 libnss3 libasound2 libgbm1 libdrm2 libxkbcommon0 libxss1 libxtst6 \
    libatk-bridge2.0-0 libatspi2.0-0 libcups2 libsecret-1-0 libnotify4 libuuid1 \
    fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Keep in step with the repo's Playwright; connectOverCDP only needs the core.
ARG PLAYWRIGHT_VERSION=1.60.0
RUN npm install -g "playwright-core@${PLAYWRIGHT_VERSION}" && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules
