# Coolify checklist for a Node realtime app

## Build/deploy model
Preferred:
- build Docker image in GitHub Actions
- push to GHCR
- let Coolify deploy the image or react to a webhook

Alternative:
- let Coolify build directly from GitHub

## App settings
- Build pack: Dockerfile
- Port: the port your Node server listens on, usually `3000`
- Health check: add `/api/health` or `/health`
- Domain: app subdomain like `https://app.example.com`

## Realtime notes
- WebSocket endpoint should stay on the same origin if possible.
- Add graceful shutdown for SIGTERM.
- Assume a brief reconnect during deploys unless the app is multi-replica and shared-state aware.
