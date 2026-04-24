"""
3D body reconstruction — SAM 3D Body (Meta) single image → posed body GLB.

DEPLOY: modal deploy pipeline.py
TEST:   modal run pipeline.py --input-path person.jpg
COST:   ~$0.03 per model (~30s on A100-40GB at $3.70/hr)

Uses SAM 3D Body (Meta, facebookresearch/sam-3d-body).
Estimates body shape + pose from a single image — suitable for apparel
try-on, fashion product visualization, and avatar-style rendering.

NOTE: this template clones the upstream repo at image-build time. Pin a
commit SHA before going to production so behavior is reproducible.
"""

import io
import modal

app = modal.App("3d-sam-body")

volume = modal.Volume.from_name("ml-model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1-mesa-glx", "libglib2.0-0", "wget")
    .pip_install(
        "torch==2.4.0",
        "torchvision==0.19.0",
        "Pillow>=10.0.0",
        "numpy>=1.26.0",
        "trimesh>=4.0.0",
        "transformers>=4.44.0",
        "einops>=0.7.0",
        "omegaconf>=2.3.0",
        "huggingface-hub>=0.24.0",
        "smplx>=0.1.28",
        "chumpy>=0.70",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
    )
    .run_commands(
        "git clone https://github.com/facebookresearch/sam-3d-body.git /opt/sam3d-body",
        "cd /opt/sam3d-body && pip install -e .",
    )
)


@app.function(
    gpu="A100-40GB",
    image=image,
    volumes={"/models": volume},
    timeout=120,
    container_idle_timeout=300,
)
def generate_body(image_bytes: bytes) -> dict:
    from PIL import Image

    pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    from huggingface_hub import snapshot_download
    model_dir = "/models/sam-3d-body"
    try:
        snapshot_download("facebook/sam-3d-body", local_dir=model_dir)
    except Exception:
        pass

    import sys
    if "/opt/sam3d-body" not in sys.path:
        sys.path.insert(0, "/opt/sam3d-body")

    from sam3d_body.pipeline import SAM3DBodyPipeline

    pipe = SAM3DBodyPipeline.from_pretrained(model_dir)
    pipe.to("cuda")

    result = pipe(image=pil_image)
    mesh = result["mesh"]
    pose_params = result.get("pose", {})

    glb_bytes = mesh.export(file_type="glb")

    return {
        "glb_bytes": glb_bytes,
        "format": "glb",
        "vertices": len(mesh.vertices) if hasattr(mesh, "vertices") else 0,
        "pose": pose_params,
    }


@app.function(image=image, timeout=180)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    import base64
    from starlette.responses import JSONResponse, Response

    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        if not file:
            return JSONResponse({"error": "No file uploaded"}, status_code=400)
        image_bytes = await file.read()
    elif "application/json" in content_type:
        body = await request.json()
        if "image_base64" not in body:
            return JSONResponse({"error": "Missing image_base64 field"}, status_code=400)
        image_bytes = base64.b64decode(body["image_base64"])
    else:
        return JSONResponse({"error": "Unsupported content type"}, status_code=415)

    try:
        result = generate_body.remote(image_bytes)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    return Response(
        content=result["glb_bytes"],
        media_type="model/gltf-binary",
        headers={
            "Content-Disposition": "attachment; filename=body.glb",
            "X-Vertex-Count": str(result["vertices"]),
            "X-Model": "sam-3d-body",
        },
    )


@app.local_entrypoint()
def main(input_path: str = "person.jpg"):
    with open(input_path, "rb") as f:
        image_bytes = f.read()

    print(f"Reconstructing body (SAM 3D Body) from {input_path}...")
    result = generate_body.remote(image_bytes)

    output_path = input_path.rsplit(".", 1)[0] + "_body.glb"
    with open(output_path, "wb") as f:
        f.write(result["glb_bytes"])

    print(f"Saved {output_path} ({result['vertices']} vertices)")
