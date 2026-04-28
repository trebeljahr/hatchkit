# Zero downtime for realtime apps

## The honest version
A single-replica WebSocket app is not truly zero downtime during deploys.
When the only container is replaced, active socket connections drop.

## What helps on a single replica
- Graceful SIGTERM handling.
- Health checks.
- Fast startup.
- Client reconnect logic.

This produces a nicer deploy, but not true zero downtime.

## What near-zero-downtime actually needs
- 2+ replicas.
- Shared state outside the Node process.
- Shared pubsub/fanout for live events.
- Health checks and rolling updates.
- Idempotent reconnects on the client.

## Realtime-specific warning for in-memory game servers
If room state or socket ownership lives inside a single Node process, scaling horizontally will break behavior unless you externalize that coordination.
