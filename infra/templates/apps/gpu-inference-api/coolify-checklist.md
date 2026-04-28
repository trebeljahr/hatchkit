# GPU Inference API — Coolify Deployment Checklist

## Pre-deployment

- [ ] Terraform stack applied (`make tf-apply STACK=gpu-inference`)
- [ ] Server hardened (`make harden`)
- [ ] Coolify installed and configured with domain + HTTPS
- [ ] Bootstrap port locked down (`make lockdown`)
- [ ] S3 buckets created (check `terraform output`)
- [ ] GPU platform account set up (Modal / RunPod / AWS)

## Coolify setup

- [ ] Run `make coolify-setup STACK=gpu-inference`
- [ ] Verify environment variables are set in Coolify dashboard
- [ ] Set up GitHub webhook for automatic deploys

## GPU platform setup

### Modal (recommended for V1)
- [ ] `pip install modal && modal setup`
- [ ] Deploy: `cd modal/ && modal deploy pipeline.py`
- [ ] Note the endpoint URL from Modal dashboard
- [ ] Set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in Coolify env

### RunPod (budget option)
- [ ] Create account at runpod.io
- [ ] Build and push Docker image with GPU pipeline
- [ ] Create Serverless Endpoint, note the endpoint ID
- [ ] Set `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` in Coolify env

## Post-deployment verification

- [ ] `curl https://api.3d.example.com/health` returns 200
- [ ] Upload a test image, verify GLB generation works
- [ ] Check S3 buckets have upload + model files
- [ ] Verify presigned URLs are accessible
- [ ] Check GPU platform dashboard for successful inference logs

## Monitoring

- [ ] GlitchTip/Sentry DSN configured for error tracking
- [ ] GPU platform billing alerts set up
- [ ] S3 storage usage monitoring
