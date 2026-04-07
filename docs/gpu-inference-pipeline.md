# GPU Inference Pipeline for 3D Model Generation

Guide for deploying a photo-to-3D pipeline on GPU infrastructure. Covers AWS options, external platforms, model selection, cost analysis, and deployment patterns.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [GPU Platform Options](#gpu-platform-options)
3. [3D Reconstruction Models](#3d-reconstruction-models)
4. [Recommended Pipeline](#recommended-pipeline)
5. [AWS Deployment Patterns](#aws-deployment-patterns)
6. [External Platform Deployment](#external-platform-deployment)
7. [Cost Analysis](#cost-analysis)
8. [Cold Start Strategies](#cold-start-strategies)
9. [Issues and Gotchas](#issues-and-gotchas)

---

## Architecture Overview

```
User uploads 2-4 product photos
         │
         ▼
┌─────────────────────────────┐
│  Web API (Coolify/Hetzner)  │  ← Receives upload, queues job
│  Node/Express or FastAPI    │
└──────────┬──────────────────┘
           │ POST job to GPU service
           ▼
┌─────────────────────────────┐
│  GPU Inference Service      │  ← Runs on AWS or Modal/RunPod
│                             │
│  1. rembg (background rm)   │  CPU/GPU, 1-3s
│  2. SF3D or TRELLIS.2       │  GPU, 0.5-60s
│  3. trimesh (mesh cleanup)  │  CPU, 1-3s
│  4. Draco compress → GLB    │  CPU, <1s
│                             │
└──────────┬──────────────────┘
           │ GLB file
           ▼
┌─────────────────────────────┐
│  Object Storage             │  ← S3/R2/Hetzner Object Storage
│  (CDN-fronted)              │
└──────────┬──────────────────┘
           │ presigned URL / CDN URL
           ▼
┌─────────────────────────────┐
│  Shopify storefront         │  ← R3F viewer loads GLB
│  (theme extension)          │
└─────────────────────────────┘
```

The web API and GPU inference are decoupled. The API runs cheaply on Coolify (existing infra). The GPU work runs on a separate service that scales to zero.

---

## GPU Platform Options

### AWS Fargate — NOT an option

Fargate does not support GPUs (as of April 2026). This is the most requested feature since 2018 but hasn't shipped.

### AWS ECS Managed Instances (launched Sept 2025)

The closest thing to "Fargate with GPUs." ECS handles provisioning, scaling, patching, and placement of EC2 instances, but they run in your account with full GPU support.

- Supports g4dn, g5, g6, p3, p4d, p5 instance families
- You pick the instance family; ECS manages the rest
- Visible in EC2 console (unlike Fargate tasks)
- Supports privileged containers and GPU resource requirements

### AWS Batch (best AWS-native option for scale-to-zero)

- Set `minvCpus: 0` → natively scales to zero (no cost when idle)
- Jobs submitted to queue trigger instance launch
- Supports all GPU instance types
- 2-10 minute cold start (instance launch + container pull + model load)

### SageMaker

- Real-time endpoints support GPUs, can scale to zero (since re:Invent 2024)
- **5-20 minute cold start from zero** — too slow for on-demand product use
- Only viable if you keep at least one instance warm ($730+/mo for g5.xlarge)
- Complex setup, SageMaker-specific container requirements (/ping, /invocations)
- **Verdict: avoid for this use case**

### External Platforms (Modal, RunPod, Replicate)

| Platform | Scale to Zero | Cold Start | GPU Options | Billing |
|----------|--------------|------------|-------------|---------|
| Modal | Yes | 2-4 sec | T4, A10G, A100, H100 | Per-second |
| RunPod Serverless | Yes | <1s (FlashBoot, ~48% of requests) | A10G, A100 | Per-second |
| Replicate | Yes | Seconds | A40, A100 | Per-second |

These are significantly cheaper and faster to cold-start than any AWS option. The trade-off is vendor lock-in and less control.

### Comparison Table

| Option | Scale to Zero | Cold Start | Monthly Cost (1000 req × 30s) | Ops Burden |
|--------|--------------|------------|------------------------------|------------|
| Modal (A10G) | Yes | 2-4s | ~$9-12 | Very low |
| RunPod (A10G) | Yes | <1s-30s | ~$4-6 | Low |
| Replicate (A40) | Yes | Seconds | ~$5-8 | Very low |
| AWS Batch (g5.xlarge) | Yes | 2-10 min | ~$10-15 | Medium |
| ECS Managed (g5.xlarge) | Partial* | 2-8 min | ~$10-15 active, $724 if always-on | Medium |
| SageMaker (g5.xlarge) | Yes | 5-20 min | ~$730+ (must keep warm) | High |

*ECS Managed can scale down tasks but keeping instances at 0 means long cold starts.

---

## 3D Reconstruction Models

### Model Comparison

| Model | Params | VRAM | Inference Time | Min GPU | Quality | Notes |
|-------|--------|------|---------------|---------|---------|-------|
| **SF3D** | 1.0B | ~6 GB | **0.5-2.3s** | T4 (16GB) | Good | Built-in UV unwrap + PBR. Best speed/quality ratio. |
| **TripoSR** | 1.3B | ~6 GB (256 res) | **0.5s** (A100) | T4 (16GB) | Decent | Fast but chaotic topology, blurred details. |
| **TripoSG** | 1.5B | ~8 GB | TBD | A10G (24GB) | Better than TripoSR | March 2025, MoE transformer. |
| **InstantMesh** | varies | 16-24 GB | **~10s** | A10G (24GB) | Good for organic | Multi-view diffusion + transformer. |
| **TRELLIS v1** | - | 16 GB | **3-5 min** (A100) | A10G (24GB) | Very good | Community fork (TRELLIS-BOX) runs on 10-12GB. |
| **TRELLIS.2** | 4B | 24 GB+ | **3s** (H100), **3-5 min** (A100) | H100 or A100 | **Excellent** | 50k triangles, clean quad topology. Quality leader. |
| **Wonder3D** | - | 8 GB | **2-3 min** | T4 (16GB) | Decent | Older (2023). Low resolution (256x256). |

### Pipeline Components

| Step | Tool | GPU? | Time | Notes |
|------|------|------|------|-------|
| Background removal | rembg (BiRefNet) | Optional | 1-3s | Already deployed in ai-infra-templates |
| 3D reconstruction | SF3D / TRELLIS.2 | **Yes** | 0.5-60s | Main GPU workload |
| Mesh cleanup | trimesh / PyMeshLab | No | 1-3s | CPU only |
| UV unwrapping | xatlas (built into SF3D) | No | included | SF3D does this automatically |
| PBR materials | Built into SF3D/TRELLIS.2 | Yes | included | Part of model inference |
| Draco compression | gltf-transform | No | <1s | 60-90% file size reduction |
| GLB export | trimesh / gltf-transform | No | <1s | Web-ready output |

### Multi-View Input (2-4 photos)

Current state: true multi-view reconstruction from sparse views (2-4 photos) is still an active research area. The practical approach is:

1. Use the best single photo as the "hero" for reconstruction (SF3D/TRELLIS.2)
2. Use additional views for texture refinement or as quality validation
3. Use rembg on all views for clean segmentation

Multi-view specific models (DUSt3R, MASt3R, Fast3R) exist but are better for photogrammetry-style dense capture (50+ views) than sparse product photography.

---

## Recommended Pipeline

### Option A: Speed-Optimized (ship first with this)

**Total time: ~5-10 seconds on A10G**

```
rembg (1-3s) → SF3D (0.5-3s) → trimesh cleanup (1-3s) → Draco + GLB (<1s)
```

- GPU: g5.xlarge (A10G, 24 GB) or g4dn.xlarge (T4, 16 GB)
- SF3D outputs UV-unwrapped mesh with PBR materials
- Best bang for buck, good enough quality for product visualization
- **This is what V1 should use**

### Option B: Quality-Optimized (add as premium tier later)

**Total time: ~10-70 seconds on H100, 3-6 minutes on A100**

```
rembg (1-3s) → TRELLIS.2 at 512 (3-60s) → Draco + GLB (<1s)
```

- Requires H100 to hit 60-second target. A100 is 3-5 minutes.
- 50k triangles, clean quad topology
- Offer as "HD" option with longer wait time

### Option C: Two-Tier (recommended product design)

- **Fast preview** (free/low tier): SF3D, ~10 seconds, good quality
- **HD model** (paid tier): TRELLIS.2, 1-3 minutes, excellent quality
- User sees the fast preview immediately, HD model processes in background

---

## AWS Deployment Patterns

### Pattern 1: AWS Batch (Scale to Zero)

Best AWS-native option. Pay nothing when idle. Accept 2-10 minute cold starts.

```
┌──────────────┐     ┌──────────┐     ┌─────────────────────┐
│  Web API     │────▶│ SQS      │────▶│ AWS Batch           │
│  (Coolify)   │     │ Queue    │     │ Compute Env:        │
│              │◀────│          │     │  g5.xlarge           │
│  polls for   │     └──────────┘     │  minvCpus: 0        │
│  result      │                      │  maxvCpus: 8         │
└──────────────┘                      │  Docker: ECR image   │
                                      └──────────┬──────────┘
                                                 │
                                                 ▼
                                      ┌──────────────────────┐
                                      │  S3 / Hetzner ObjSt  │
                                      │  (GLB output)        │
                                      └──────────────────────┘
```

**Setup:**

1. Create ECR repo, push Docker image with model weights
2. Create Batch Compute Environment:
   ```json
   {
     "type": "MANAGED",
     "computeResources": {
       "type": "EC2",
       "minvCpus": 0,
       "maxvCpus": 8,
       "instanceTypes": ["g5.xlarge"],
       "subnets": ["subnet-xxx"],
       "securityGroupIds": ["sg-xxx"]
     }
   }
   ```
3. Create Job Queue + Job Definition (with GPU resource requirement)
4. Web API submits jobs via `aws batch submit-job`
5. Poll for completion or use EventBridge → webhook callback

**Pros:** True scale to zero, AWS-native, IAM security model
**Cons:** 2-10 min cold start, more moving parts than external platforms

### Pattern 2: ECS Managed Instances (Warm Pool)

For when cold starts are unacceptable but you want AWS.

```
┌──────────────┐     ┌──────────────────────────┐
│  Web API     │────▶│ ECS Service              │
│  (Coolify)   │     │ Task: GPU inference       │
│              │◀────│ Capacity: Managed Inst.   │
└──────────────┘     │ Min: 1, Max: 4            │
                     │ Instance: g5.xlarge        │
                     └──────────────────────────┘
```

**Cost:** ~$724/mo minimum (1x g5.xlarge always running). Only viable once you have steady traffic.

**Setup:**

1. Create ECS cluster with managed instance capacity provider
2. Task definition with `resourceRequirements: [{ type: "GPU", value: "1" }]`
3. Service auto-scaling based on queue depth or request count
4. Use ECS-optimized GPU AMI (has NVIDIA Container Toolkit pre-installed)

### Pattern 3: Hybrid (Batch for Scale-to-Zero + ECS for Warm)

Start with Batch (Pattern 1). Once traffic justifies it, add an ECS warm pool for low-latency, fall back to Batch for overflow.

### Terraform Additions Needed

Add to `dev-ops-automation/terraform/`:

```
stacks/
  gpu-inference/
    main.tf          # ECR, Batch compute env, job queue, job def, IAM
    variables.tf     # Instance type, model image, S3 bucket
    outputs.tf       # Job queue ARN, ECR repo URL
    terraform.tfvars
```

Reuse patterns from existing `node-realtime` stack. Add:
- ECR repository for the inference container
- Batch compute environment (or ECS cluster with GPU capacity provider)
- IAM roles for Batch/ECS to access ECR and S3
- S3 bucket for model outputs (or reuse Hetzner Object Storage via S3-compatible API)
- SQS queue for async job submission
- EventBridge rule for job completion notifications

---

## External Platform Deployment

### Modal (Recommended for V1)

Simplest path to production. No infrastructure to manage.

```python
import modal

app = modal.App("photo-to-3d")

# Persistent volume for model weights (survives cold starts)
volume = modal.Volume.from_name("model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch", "torchvision", "trimesh", "rembg", "gltf-pipeline")
    .pip_install("sf3d")  # or trellis
)

@app.function(
    gpu="A10G",
    image=image,
    volumes={"/models": volume},
    timeout=120,
    container_idle_timeout=300,  # keep warm for 5 min after last request
)
def generate_3d(image_bytes: bytes) -> bytes:
    # 1. Background removal
    from rembg import remove
    clean_image = remove(image_bytes)

    # 2. SF3D reconstruction
    mesh = run_sf3d(clean_image)

    # 3. Mesh cleanup + Draco compression
    glb_bytes = export_draco_glb(mesh)

    return glb_bytes

@app.function()
@modal.web_endpoint(method="POST")
def api(request):
    # HTTP endpoint that Modal hosts for you
    image_bytes = request.body
    glb = generate_3d.remote(image_bytes)
    return Response(content=glb, media_type="model/gltf-binary")
```

**Deploy:** `modal deploy pipeline.py`
**Cost:** ~$0.0003 per request (30s on A10G at $1.10/hr)
**Cold start:** 2-4 seconds

### RunPod Serverless

Cheaper but more DIY.

```python
# handler.py (RunPod serverless handler format)
import runpod

def handler(event):
    image_bytes = event["input"]["image"]
    # ... same pipeline ...
    return {"glb_url": upload_to_s3(glb_bytes)}

runpod.serverless.start({"handler": handler})
```

```dockerfile
FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel
COPY . /app
WORKDIR /app
RUN pip install -r requirements.txt
CMD ["python", "handler.py"]
```

**Deploy:** Push to Docker Hub → Create RunPod Serverless Endpoint → point to image
**Cost:** ~$0.44/hr A10G (~60% cheaper than Modal)
**Cold start:** <1s with FlashBoot (48% of requests), 5-30s otherwise

---

## Cost Analysis

### Per-Request Cost (single 3D model generation, ~30 seconds GPU time)

| Platform | GPU | Cost/Request | 1,000 req/mo | 10,000 req/mo |
|----------|-----|-------------|-------------|--------------|
| Modal | A10G | $0.009 | $9 | $92 |
| RunPod | A10G | $0.004 | $4 | $37 |
| Replicate | A40 | $0.005 | $5 | $46 |
| AWS Batch (g5.xlarge) | A10G | $0.008 + instance overhead | $10-15 | $80-120 |
| AWS ECS always-on (g5) | A10G | $724/mo flat | $724 | $724 |

### Break-Even: External vs AWS Always-On

AWS ECS always-on g5.xlarge = $724/mo
Modal A10G at $0.009/req → break-even at ~80,000 requests/month

**You'd need 80k+ requests/month before running your own GPU makes financial sense.** Start with Modal or RunPod. Switch to AWS when traffic justifies it.

### Revenue vs Cost

If you charge $5/model generation (standalone) or bundle into $39-199/mo subscriptions:

| Monthly Requests | Infra Cost (Modal) | Revenue ($5/model) | Margin |
|-----------------|-------------------|-------------------|--------|
| 100 | $1 | $500 | 99.8% |
| 1,000 | $9 | $5,000 | 99.8% |
| 10,000 | $92 | $50,000 | 99.8% |
| 100,000 | $920 | $500,000 | 99.8% |

The unit economics are excellent at any scale with external platforms.

---

## Cold Start Strategies

Cold starts matter because users don't want to wait 10 minutes for a 3D model.

### Strategy 1: Warm Pool (simplest)

Keep 1 container running at all times.
- Modal: `min_containers=1` → ~$800/mo for A10G
- RunPod: "Active Workers" → reduced rate
- Only viable once revenue covers this

### Strategy 2: Predictive Warming

Pre-warm containers during business hours (when most Shopify merchants are active):
- Modal/RunPod: schedule warm-up pings via cron
- Containers stay warm for `idle_timeout` after last request
- Cost: fraction of 24/7 warm pool

### Strategy 3: Async with Fast Preview (recommended for V1)

1. User uploads photos → immediately gets a "processing" state
2. Background job runs on cold GPU (2-60 second delay depending on platform)
3. User gets notified when model is ready (webhook, polling, or WebSocket)
4. For the Shopify app: merchant sets up models in advance, not real-time during checkout

This sidesteps the cold start problem entirely. Merchants don't need instant generation — they're setting up their store, not serving live customers.

### Strategy 4: Model Size Optimization

Large model weights dominate cold start time. Reduce by:
- Quantize to FP16 or INT8 (halves model size, minimal quality loss)
- Use Modal volumes / RunPod network volumes (model cached on NVMe, not re-downloaded)
- Use smaller models for the fast tier (SF3D at ~3GB vs TRELLIS.2 at 10GB+)

---

## Issues and Gotchas

### 1. Fargate GPU Doesn't Exist

The biggest gotcha. Despite many blog posts and StackOverflow answers implying otherwise, Fargate cannot run GPU workloads. You must use EC2-backed ECS, ECS Managed Instances, Batch, or external platforms.

### 2. Large Container Images

ML containers with model weights are 5-15 GB. This causes:
- **Slow ECR pulls** on AWS (5-10 min for cold instance). Mitigate with EBS snapshot caching or S3 Mountpoint for model weights.
- **Slow Docker builds**. Use multi-stage builds. Cache model download as a separate layer.
- **ECR storage costs**. ~$0.10/GB/month. A 15 GB image costs $1.50/mo. Negligible.

### 3. GPU Instance Availability

Spot instances (60-70% cheaper) can be reclaimed. For Batch:
- Use mixed instance types (g5 + g4dn) for better availability
- Set `allocationStrategy: BEST_FIT_PROGRESSIVE`
- Fall back to on-demand if spot unavailable

For external platforms: Modal and RunPod handle this transparently but may queue requests during high demand.

### 4. CUDA Version Compatibility

Model dependencies pin specific CUDA versions. Ensure your Docker base image matches:
- SF3D: CUDA 11.8 or 12.1
- TRELLIS.2: CUDA 12.1+
- rembg: CPU or CUDA 11.8+

Use `nvidia/cuda:12.1.0-runtime-ubuntu22.04` or `pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime` as base images.

### 5. Memory vs VRAM

VRAM (GPU memory) and system RAM are separate concerns:
- SF3D needs ~6 GB VRAM + ~8 GB RAM
- TRELLIS.2 needs ~24 GB VRAM + ~32 GB RAM
- g5.xlarge has 24 GB VRAM + 16 GB RAM → may need g5.2xlarge (24 GB VRAM + 32 GB RAM) for TRELLIS.2

### 6. Output Quality Varies by Product Type

Some products reconstruct better than others:
- **Great**: hard-surface objects (bottles, electronics, jewelry, furniture)
- **Decent**: shoes, bags, accessories
- **Difficult**: clothing/fabric (deformable), glass/transparent objects, very thin objects
- **Bad**: food, plants, anything with fine hair/fur

Build quality expectations into the product — show examples of what works well.

### 7. Shopify App Store Review

The app store review process takes 1-4 weeks. During this time:
- You can still test via development stores
- Use "unlisted" app distribution for beta testing
- The 3D viewer (theme extension) and the admin app are reviewed separately

### 8. Model Licensing

Check licenses before shipping:
- **SF3D**: Stability AI Community License (free for commercial use under $1M revenue, then requires enterprise license)
- **TripoSR**: MIT license (fully open)
- **TRELLIS.2**: MIT license (fully open)
- **rembg**: MIT license

SF3D's revenue threshold is something to watch. TripoSR or TRELLIS.2 are safer for a commercial product.

### 9. Async Job Management

For the Batch/queue-based approach, you need:
- Job status tracking (pending → processing → complete → failed)
- Result expiration (presigned URLs expire, clean up S3 after N days)
- Retry logic (GPU OOM, timeout, transient failures)
- Webhook or polling endpoint for the web app to check status
- Dead letter queue for failed jobs

The existing `ai-infra-templates` S3 lifecycle pattern (7-day expiration) applies here.

### 10. Hetzner vs AWS for Storage

Generated GLB files need to be served fast (CDN). Options:
- **Hetzner Object Storage** ($4.99/mo for 1 TB) — already in your infra. S3-compatible. Put Cloudflare in front for CDN.
- **AWS S3 + CloudFront** — standard but more expensive.
- **Cloudflare R2** — zero egress fees, S3-compatible API, built-in CDN.

R2 is probably the best option for serving GLB files given zero egress costs. 3D models are large (1-20 MB each) and egress adds up fast on S3.

---

## Migration Path

### Phase 1: External Platform (Modal/RunPod)
- Ship fastest, cheapest, least ops
- Perfect for 0 → 10,000 requests/month
- Total infra cost: <$100/mo

### Phase 2: AWS Batch (scale-to-zero)
- When you want more control, HIPAA/SOC2, or AWS-native integration
- Terraform stack in `dev-ops-automation/terraform/stacks/gpu-inference/`
- Same Docker container, different deployment target
- Total infra cost: usage-based, similar to external platforms

### Phase 3: ECS Managed Instances (warm pool)
- When traffic justifies always-on GPU (~80k+ requests/month)
- Sub-second response times
- Total infra cost: $724+/mo per instance

Each phase uses the same Docker container and pipeline code. Only the deployment wrapper changes.
