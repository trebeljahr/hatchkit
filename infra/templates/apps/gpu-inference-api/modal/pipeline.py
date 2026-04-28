"""
Modal deployment for the photo-to-3D GPU inference pipeline.

This runs on Modal's serverless GPU infrastructure. The API server on Coolify
calls this endpoint to generate 3D models from product photos.

DEPLOY:
  pip install modal
  modal setup          # one-time auth
  modal deploy pipeline.py

TEST:
  modal run pipeline.py --input-path test.jpg

COST:
  ~$0.009 per generation (30s on A10G at $1.10/hr)
  Scales to zero when not in use.
"""

import io
import modal

app = modal.App("photo-to-3d")

# Persistent volume for model weights — survives cold starts.
# First run downloads the model; subsequent runs load from cache.
volume = modal.Volume.from_name("model-weights", create_if_missing=True)

# Container image with all dependencies pre-installed.
# This is built once and cached by Modal.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1-mesa-glx", "libglib2.0-0")  # OpenCV deps
    .pip_install(
        "torch==2.3.0",
        "torchvision==0.18.0",
        "rembg[gpu]>=2.0.57",
        "trimesh>=4.0.0",
        "Pillow>=10.0.0",
        "numpy>=1.26.0",
        "httpx>=0.27.0",
        "boto3>=1.34.0",
    )
    # SF3D / TripoSR — uncomment the one you're using:
    # .pip_install("sf3d")
    # .pip_install("tsr")  # TripoSR
)


@app.function(
    gpu="A10G",
    image=image,
    volumes={"/models": volume},
    timeout=120,
    container_idle_timeout=300,  # keep warm 5 min after last request
    retries=1,
)
def generate_3d_model(
    image_bytes: bytes,
    model_name: str = "sf3d",
    output_format: str = "glb",
) -> bytes:
    """
    Generate a 3D model from a product photo.

    Args:
        image_bytes: JPEG/PNG image data
        model_name: "sf3d", "triposr", or "trellis2"
        output_format: "glb" (default) or "gltf"

    Returns:
        GLB file bytes (Draco-compressed)
    """
    from PIL import Image
    from rembg import remove

    # 1. Background removal
    clean_bytes = remove(image_bytes)
    clean_image = Image.open(io.BytesIO(clean_bytes)).convert("RGBA")

    # 2. 3D reconstruction
    if model_name == "sf3d":
        mesh = _run_sf3d(clean_image)
    elif model_name == "triposr":
        mesh = _run_triposr(clean_image)
    else:
        raise ValueError(f"Unknown model: {model_name}")

    # 3. Export as GLB
    glb_bytes = _export_glb(mesh)

    return glb_bytes


def _run_sf3d(image):
    """Run SF3D reconstruction. Replace with actual SF3D inference code."""
    # TODO: Implement SF3D inference
    # from sf3d import SF3DModel
    # model = SF3DModel.from_pretrained("/models/sf3d")
    # mesh = model(image)
    # return mesh
    raise NotImplementedError(
        "SF3D inference not yet implemented. "
        "See https://github.com/Stability-AI/stable-fast-3d"
    )


def _run_triposr(image):
    """Run TripoSR reconstruction. Replace with actual TripoSR inference code."""
    # TODO: Implement TripoSR inference
    # from tsr.system import TSR
    # model = TSR.from_pretrained("/models/triposr")
    # mesh = model(image, chunk_size=8192)
    # return mesh
    raise NotImplementedError(
        "TripoSR inference not yet implemented. "
        "See https://github.com/VAST-AI-Research/TripoSR"
    )


def _export_glb(mesh) -> bytes:
    """Export trimesh to Draco-compressed GLB bytes."""
    import trimesh

    if not isinstance(mesh, trimesh.Trimesh):
        raise TypeError(f"Expected trimesh.Trimesh, got {type(mesh)}")

    # Export to GLB (binary GLTF)
    glb_bytes = mesh.export(file_type="glb")
    return glb_bytes


# --- HTTP endpoint (Modal hosts this for you) ---


@app.function(image=image, timeout=180)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    """
    HTTP endpoint for the Coolify API server to call.

    POST /generate
    Content-Type: multipart/form-data
    Body: file=<image>, model=sf3d

    Returns: GLB file bytes
    """
    import json

    form = await request.form()
    file = form.get("file")
    model_name = form.get("model", "sf3d")

    if not file:
        return modal.web_endpoint.Response(
            content=json.dumps({"error": "No file uploaded"}),
            status_code=400,
            media_type="application/json",
        )

    image_bytes = await file.read()
    glb_bytes = generate_3d_model.remote(image_bytes, model_name=model_name)

    return modal.web_endpoint.Response(
        content=glb_bytes,
        media_type="model/gltf-binary",
        headers={
            "Content-Disposition": "attachment; filename=model.glb",
        },
    )


# --- CLI entry point for testing ---

@app.local_entrypoint()
def main(input_path: str = "test.jpg"):
    """Test locally: modal run pipeline.py --input-path photo.jpg"""
    with open(input_path, "rb") as f:
        image_bytes = f.read()

    print(f"Processing {input_path}...")
    glb_bytes = generate_3d_model.remote(image_bytes)

    output_path = input_path.rsplit(".", 1)[0] + ".glb"
    with open(output_path, "wb") as f:
        f.write(glb_bytes)

    print(f"Generated {output_path} ({len(glb_bytes) / 1024:.1f} KB)")
