"""
3D model extraction — TRELLIS 2 (Microsoft) single image → GLB.

DEPLOY: modal deploy pipeline.py
TEST:   modal run pipeline.py --input-path test.jpg
COST:   ~$0.04 per model (~45s on A100-40GB at $3.70/hr)

Uses TRELLIS 2 (Microsoft Research, microsoft/TRELLIS-2).
Sparse-voxel ("O-Voxel") 3D generation with strong topology + PBR
materials. CVPR'25 Spotlight. Open-source (MIT).

NOTE: this template clones the upstream repo at image-build time. Pin a
commit SHA before going to production so behavior is reproducible.
"""

import io
import modal

app = modal.App("3d-trellis")

volume = modal.Volume.from_name("ml-model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1-mesa-glx", "libglib2.0-0", "wget", "build-essential")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        "Pillow>=10.0.0",
        "numpy>=1.26.0",
        "trimesh>=4.0.0",
        "rembg[gpu]>=2.0.57",
        "transformers>=4.44.0",
        "einops>=0.7.0",
        "omegaconf>=2.3.0",
        "huggingface-hub>=0.24.0",
        "diffusers>=0.30.0",
        "accelerate>=0.33.0",
        "xatlas>=0.0.9",
        "pymeshlab>=2023.12",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
    )
    .run_commands(
        "git clone https://github.com/microsoft/TRELLIS.2.git /opt/trellis",
        "cd /opt/trellis && pip install -e .",
        # TRELLIS uses flash-attn + xformers for speed — optional, best-effort.
        "pip install flash-attn==2.6.3 --no-build-isolation || true",
        "pip install xformers==0.0.27.post2 || true",
    )
)


@app.function(
    gpu="A100-40GB",
    image=image,
    volumes={"/models": volume},
    timeout=300,
    container_idle_timeout=300,
)
def generate_3d(
    image_bytes: bytes,
    remove_bg: bool = True,
    output_format: str = "glb",  # "glb" | "ply" (gaussian) | "both"
    sparse_structure_steps: int = 12,
    slat_steps: int = 12,
    guidance_scale: float = 7.5,
) -> dict:
    from PIL import Image
    from rembg import remove

    pil_image = Image.open(io.BytesIO(image_bytes))
    if remove_bg:
        pil_image = Image.open(io.BytesIO(remove(image_bytes)))

    if pil_image.mode != "RGBA":
        pil_image = pil_image.convert("RGBA")

    from huggingface_hub import snapshot_download
    model_dir = "/models/trellis-2"
    try:
        snapshot_download("microsoft/TRELLIS-2-image-large", local_dir=model_dir)
    except Exception:
        pass

    import sys
    if "/opt/trellis" not in sys.path:
        sys.path.insert(0, "/opt/trellis")

    from trellis.pipelines import TrellisImageTo3DPipeline

    pipe = TrellisImageTo3DPipeline.from_pretrained(model_dir)
    pipe.cuda()

    outputs = pipe.run(
        pil_image,
        sparse_structure_sampler_params={"steps": sparse_structure_steps, "cfg_strength": guidance_scale},
        slat_sampler_params={"steps": slat_steps, "cfg_strength": guidance_scale},
    )

    mesh = outputs["mesh"][0]

    # TRELLIS meshes need texture baking for GLB export with textures.
    from trellis.utils import postprocessing_utils
    glb = postprocessing_utils.to_glb(
        outputs["gaussian"][0],
        mesh,
        simplify=0.95,
        texture_size=1024,
    )

    import io as _io
    buf = _io.BytesIO()
    glb.export(buf, file_type="glb")
    glb_bytes = buf.getvalue()

    return {
        "glb_bytes": glb_bytes,
        "format": "glb",
        "vertices": len(mesh.vertices) if hasattr(mesh, "vertices") else 0,
    }


@app.function(image=image, timeout=360)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    import base64
    from starlette.responses import JSONResponse, Response

    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        remove_bg = form.get("remove_bg", "true").lower() == "true"
        if not file:
            return JSONResponse({"error": "No file uploaded"}, status_code=400)
        image_bytes = await file.read()
    elif "application/json" in content_type:
        body = await request.json()
        if "image_base64" not in body:
            return JSONResponse({"error": "Missing image_base64 field"}, status_code=400)
        image_bytes = base64.b64decode(body["image_base64"])
        remove_bg = body.get("remove_bg", True)
    else:
        return JSONResponse({"error": "Unsupported content type"}, status_code=415)

    try:
        result = generate_3d.remote(image_bytes, remove_bg=remove_bg)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    return Response(
        content=result["glb_bytes"],
        media_type="model/gltf-binary",
        headers={
            "Content-Disposition": "attachment; filename=model.glb",
            "X-Vertex-Count": str(result["vertices"]),
            "X-Model": "trellis-2",
        },
    )


@app.local_entrypoint()
def main(input_path: str = "test.jpg"):
    with open(input_path, "rb") as f:
        image_bytes = f.read()

    print(f"Generating 3D (TRELLIS 2) from {input_path}...")
    result = generate_3d.remote(image_bytes)

    output_path = input_path.rsplit(".", 1)[0] + ".glb"
    with open(output_path, "wb") as f:
        f.write(result["glb_bytes"])

    print(f"Saved {output_path} ({result['vertices']} vertices)")
