# Coolify stamps

A stamp is a repeatable combination of app shape, services, deployment method, and operational expectations.

## node-web-http
Use when the app is mostly HTTP request/response.
- App: one Node container.
- State: external DB.
- Deployments: Docker image from GitHub Actions to GHCR, then Coolify webhook.
- Downtime target: very low if health checks are good.

## node-realtime-single
Use when the app has WebSockets but a brief reconnect during deploys is acceptable.
- App: one Node container.
- State: persistent DB, but live connection registry can remain in memory.
- Deployments: same as above.
- Downtime target: low, but not zero. Existing sockets drop on deploy.

## node-realtime-ha
Use when live connections should survive deploys better.
- App: 2+ replicas.
- State: no process-local authority.
- Shared fanout: Redis or another pubsub layer.
- Load balancing: Traefik/Coolify with health checks.
- Downtime target: near-zero, assuming clients reconnect cleanly.

## node-api-postgres
Use for CRUD-heavy apps, billing, relational data, and reporting.
- DB: PostgreSQL.
- App: one or more stateless Node containers.

## node-api-mongo
Use for document-heavy data models and flexible schemas.
- DB: MongoDB.
- App: one or more stateless Node containers.

## Default deployment recommendation
For small SaaS projects on one VPS:
- Build Docker images in GitHub Actions.
- Push to GHCR.
- Deploy via Coolify webhook or image update.
- Keep builds off the VPS when possible.
