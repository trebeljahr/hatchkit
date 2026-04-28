"""
3D model extraction service — TripoSR (single image to 3D mesh).

DEPLOY: modal deploy pipeline.py
TEST:   modal run pipeline.py --input-path test.jpg
COST:   ~$0.005 per model (3-5s on A10G at $1.10/hr)

Uses TripoSR (MIT license, safe for commercial use).
"""

import io
import modal

app = modal.App("3d-extraction")

volume = modal.Volume.from_name("ml-model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1-mesa-glx", "libglib2.0-0", "wget")
    .pip_install(
        "torch>=2.1.0",
        "torchvision>=0.16.0",
        "Pillow>=10.0.0",
        "numpy>=1.26.0",
        "trimesh>=4.0.0",
        "rembg[gpu]>=2.0.57",
        "transformers>=4.36.0",
        "einops>=0.7.0",
        "omegaconf>=2.3.0",
        "huggingface-hub>=0.20.0",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
    )
)


@app.function(
    gpu="A10G",
    image=image,
    volumes={"/models": volume},
    timeout=120,
    container_idle_timeout=300,
)
def generate_3d(
    image_bytes: bytes,
    remove_bg: bool = True,
    foreground_ratio: float = 0.85,
    mc_resolution: int = 256,
) -> dict:
    from PIL import Image
    from rembg import remove
    import numpy as np

    pil_image = Image.open(io.BytesIO(image_bytes))

    if remove_bg:
        pil_image = Image.open(io.BytesIO(remove(image_bytes)))

    # Convert to RGB with white background if RGBA
    if pil_image.mode == "RGBA":
        bg = Image.new("RGB", pil_image.size, (255, 255, 255))
        bg.paste(pil_image, mask=pil_image.split()[3])
        pil_image = bg

    # Center and pad the image
    pil_image = pil_image.convert("RGB")
    max_dim = max(pil_image.size)
    padded = Image.new("RGB", (max_dim, max_dim), (255, 255, 255))
    offset = ((max_dim - pil_image.width) // 2, (max_dim - pil_image.height) // 2)
    padded.paste(pil_image, offset)

    # Resize to model input size
    padded = padded.resize((512, 512), Image.LANCZOS)

    # Load TripoSR
    from huggingface_hub import snapshot_download
    import sys, importlib

    model_dir = "/models/triposr"
    try:
        snapshot_download(
            "stabilityai/TripoSR",
            local_dir=model_dir,
            local_dir_use_symlinks=False,
        )
    except Exception:
        pass  # Already downloaded

    if model_dir not in sys.path:
        sys.path.insert(0, model_dir)

    from tsr.system import TSR

    tsr_model = TSR.from_pretrained(
        model_dir,
        config_name="config.yaml",
        weight_name="model.ckpt",
    )
    tsr_model.to("cuda")

    # Run inference
    with torch_inference_mode():
        import torch
        mesh = tsr_model.run_image(
            padded,
            bake_texture=True,
            texture_resolution=1024,
        )

    # Export to GLB
    import trimesh
    glb_bytes = mesh.export(file_type="glb")

    return {
        "glb_bytes": glb_bytes,
        "format": "glb",
        "vertices": len(mesh.vertices) if hasattr(mesh, "vertices") else 0,
    }


def torch_inference_mode():
    import torch
    return torch.inference_mode()


@app.function(image=image, timeout=180)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    import json
    from starlette.responses import Response, JSONResponse

    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        remove_bg = form.get("remove_bg", "true").lower() == "true"
        mc_resolution = int(form.get("resolution", "256"))
        if not file:
            return JSONResponse({"error": "No file uploaded"}, status_code=400)
        image_bytes = await file.read()
    elif "application/json" in content_type:
        import base64
        body = await request.json()
        if "image_base64" not in body:
            return JSONResponse({"error": "Missing image_base64 field"}, status_code=400)
        image_bytes = base64.b64decode(body["image_base64"])
        remove_bg = body.get("remove_bg", True)
        mc_resolution = body.get("resolution", 256)
    else:
        return JSONResponse({"error": "Unsupported content type"}, status_code=415)

    try:
        result = generate_3d.remote(
            image_bytes,
            remove_bg=remove_bg,
            mc_resolution=mc_resolution,
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    return Response(
        content=result["glb_bytes"],
        media_type="model/gltf-binary",
        headers={
            "Content-Disposition": "attachment; filename=model.glb",
            "X-Vertex-Count": str(result["vertices"]),
        },
    )


@app.local_entrypoint()
def main(input_path: str = "test.jpg"):
    with open(input_path, "rb") as f:
        image_bytes = f.read()

    print(f"Generating 3D model from {input_path}...")
    result = generate_3d.remote(image_bytes)

    output_path = input_path.rsplit(".", 1)[0] + ".glb"
    with open(output_path, "wb") as f:
        f.write(result["glb_bytes"])

    print(f"Saved {output_path} ({result['vertices']} vertices)")
