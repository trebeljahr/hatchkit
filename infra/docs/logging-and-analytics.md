# Logging and analytics

## Minimum sensible baseline
- Uptime Kuma for uptime checks.
- Coolify container logs for quick debugging.
- A managed error tracker like Sentry for exceptions.

This is enough for many small projects and keeps the VPS light.

## Better baseline
- Uptime Kuma
- Sentry Cloud
- Product analytics with Umami or Plausible
- Periodic backup verification

## When to self-host log aggregation
Only add Loki/Grafana or a similar stack once you are actually missing features from plain Docker logs.
Self-hosted observability stacks are useful, but they are not free in complexity, RAM, or disk.

## Recommended progression
1. Start with Coolify logs + Uptime Kuma.
2. Add Sentry when the first production app matters.
3. Add analytics only for apps that really need it.
4. Add centralized logging when log volume justifies it.
