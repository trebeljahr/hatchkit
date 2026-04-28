# MinIO in Coolify

Use this when you explicitly want self-hosted S3-compatible storage on the VPS.

## Suggested domains
- API: `https://minio.example.com`
- Console: `https://minio-console.example.com`

## Notes
- Pin the MinIO image tag before production use.
- Back up MinIO data off the box.
- If the app already supports generic S3 endpoints, MinIO can replace AWS S3 for many internal use cases.
