# Tiao on Coolify

## Deployment shape
Tiao is best deployed as one web app:
- Express API
- WebSocket endpoint at `/ws`
- built frontend served by the Node server

That keeps the browser on the same origin and avoids extra proxy/CORS complexity.

## Required production environment variables
Current app requirements are:
- `TOKEN_SECRET`
- `MONGODB_URI`
- `PORT`
- `ALTCHA_HMAC_KEY`
- `S3_BUCKET_NAME`
- `CLOUDFRONT_URL` or another public asset base URL
- AWS/S3 credentials

If you add a generic S3 endpoint to the app, R2, Hetzner Object Storage, and other managed S3-compatible buckets become much easier options.

## Scaling note
Tiao's multiplayer WebSocket state is currently process-local, so treat it as a single-replica realtime app for now.
That means deploys can be graceful, but not truly zero downtime for active matches.
