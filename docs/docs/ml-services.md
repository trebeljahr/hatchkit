---
sidebar_position: 5
title: ML services
---

# ML services

Hatchkit treats GPU-backed inference as a first-class feature. Pick which models you want during `create`, choose a deployment platform, and hatchkit deploys the matching service template and threads the endpoint into your app's env.

---

## 3D generation

Single image → 3D mesh (GLB). Five options — pick by quality, license, and intended product category.

| Service | Model | License | Notes |
|---|---|---|---|
| `3d-sam-objects` | **SAM 3D Objects** (Meta) | Open weights | SOTA on real-image textures (5:1 human-preference win). Default. |
| `3d-sam-body` | **SAM 3D Body** (Meta) | Open weights | Posed human-body reconstruction. For apparel / try-on. |
| `3d-hunyuan` | **Hunyuan3D** (Tencent) | Non-commercial† | 4–8K PBR textures. Highest open-weight quality. |
| `3d-trellis` | **TRELLIS 2** (Microsoft) | MIT | Sparse-voxel geometry. Strong topology. |
| `3d-extraction` | **TripoSR** (Stability AI) | MIT | Legacy — lost the 2024–2025 benchmarks. Kept for back-compat. |

†Tencent offers a separate commercial license on request — verify terms before shipping.

### Which one to pick

**Most product photography** → `3d-sam-objects`. Meta benchmarked it specifically on real, in-the-wild images.

**Apparel or models-on-product** → also pick `3d-sam-body`. Pairs with objects for end-to-end fashion / try-on.

**Highest geometric fidelity** (heavier compute, license caveat) → `3d-hunyuan`.

**MIT-licensed alternative** if Hunyuan's license is a blocker → `3d-trellis`.

**`3d-extraction` is legacy.** Skip for new projects.

---

## Vision, audio, custom

| Service | Model | Input → Output |
|---|---|---|
| `image-recognition` | CLIP | image → labels + scores |
| `subtitles` | Whisper large-v3 | audio / video → SRT / VTT |
| `background-removal` | RMBG-2.0 | image → RGBA with alpha |
| `custom-hf` | _any HuggingFace model_ | configurable per use case |

For `custom-hf`, hatchkit prompts for a HuggingFace model ID (e.g. `runwayml/stable-diffusion-v1-5`) and deploys via the Hugging Face Inference Endpoints API.

---

## Deployment platforms

Each service can deploy to one of four platforms:

| Platform | Best for |
|---|---|
| **Modal** | Fastest iteration loop; best DX. |
| **RunPod** | Cheap serverless GPUs with broad SKU choice. |
| **Hugging Face** | Hosted HF models with zero infra. |
| **Replicate** | Already use Replicate or want easy public sharing. |

Configure with `hatchkit config add <modal|runpod|hf|replicate>` — tokens go to the OS keychain. See [Providers](./providers) for full setup.

---

## The deploy flow

On `hatchkit create`, after Terraform + Coolify finish:

1. For each selected service, hatchkit checks its **registry** (`config.json`). If you've already deployed this service-platform pair, it reuses the existing endpoint.
2. Otherwise it deploys the template (e.g. `services/ml/3d-sam-objects/modal/pipeline.py`) and captures the endpoint URL.
3. The endpoint is injected into the app as `ML_<SERVICE>_ENDPOINT` (e.g. `ML_3D_SAM_OBJECTS_ENDPOINT`).
4. The starter app's tRPC router has matching mutations and playground pages wired to those env vars out of the box.

---

## Pipeline anatomy

Each service template under `services/ml/<service>/` ships:

- a **model loader** that downloads weights via `huggingface_hub.snapshot_download`,
- a **platform entrypoint** (e.g. `modal/pipeline.py`) defining the GPU function and a public web endpoint,
- pinned Python dependencies in the image build spec.

The web endpoint accepts `multipart/form-data` (`file=...`) or JSON (`{ image_base64: "..." }`) and returns raw GLB bytes with `model/gltf-binary` content type. Same shape across all four 3D models — your app code is portable.

---

## Reuse across projects

Every deployed ML service is recorded in the hatchkit ML registry, keyed by `service:platform`. When a later project picks the same service, hatchkit **reuses** the existing endpoint instead of re-deploying.

Inspect the registry with `hatchkit config`; force a redeploy by selecting the service in the wizard's "redeploy these?" prompt.
