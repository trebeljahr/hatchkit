"""
Background removal service — rembg with BiRefNet model.

DEPLOY: modal deploy pipeline.py
TEST:   modal run pipeline.py --input-path test.jpg
COST:   ~$0.001 per image (2-3s on T4 at $0.59/hr)
"""

import io
import modal

app = modal.App("background-removal")

volume = modal.Volume.from_name("ml-model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "rembg[gpu]>=2.0.57",
        "Pillow>=10.0.0",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
    )
)


@app.function(
    gpu="T4",
    image=image,
    volumes={"/models": volume},
    timeout=60,
    container_idle_timeout=300,
)
def remove_background(image_bytes: bytes, model_name: str = "birefnet-general") -> dict:
    from rembg import remove, new_session
    from PIL import Image

    session = new_session(model_name)
    result_bytes = remove(
        image_bytes,
        session=session,
        post_process_mask=True,
    )
    result_image = Image.open(io.BytesIO(result_bytes))

    output = io.BytesIO()
    result_image.save(output, format="PNG")
    output.seek(0)

    return {
        "image_bytes": output.getvalue(),
        "format": "png",
        "width": result_image.width,
        "height": result_image.height,
    }


@app.function(image=image, timeout=120)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    import json
    from starlette.responses import Response

    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        model = form.get("model", "birefnet-general")
        if not file:
            return Response(
                content=json.dumps({"error": "No file uploaded"}),
                status_code=400,
                media_type="application/json",
            )
        image_bytes = await file.read()
    elif "application/json" in content_type:
        body = await request.json()
        import base64
        if "image_base64" not in body:
            return Response(
                content=json.dumps({"error": "Missing image_base64 field"}),
                status_code=400,
                media_type="application/json",
            )
        image_bytes = base64.b64decode(body["image_base64"])
        model = body.get("model", "birefnet-general")
    else:
        return Response(
            content=json.dumps({"error": "Unsupported content type"}),
            status_code=415,
            media_type="application/json",
        )

    try:
        result = remove_background.remote(image_bytes, model_name=model)
    except Exception as e:
        return Response(
            content=json.dumps({"error": str(e)}),
            status_code=500,
            media_type="application/json",
        )

    return Response(
        content=result["image_bytes"],
        media_type="image/png",
        headers={
            "Content-Disposition": "attachment; filename=removed-bg.png",
            "X-Image-Width": str(result["width"]),
            "X-Image-Height": str(result["height"]),
        },
    )


@app.local_entrypoint()
def main(input_path: str = "test.jpg"):
    with open(input_path, "rb") as f:
        image_bytes = f.read()

    print(f"Processing {input_path}...")
    result = remove_background.remote(image_bytes)

    output_path = input_path.rsplit(".", 1)[0] + "-nobg.png"
    with open(output_path, "wb") as f:
        f.write(result["image_bytes"])

    print(f"Saved {output_path} ({result['width']}x{result['height']})")
