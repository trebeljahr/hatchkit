"""
Image recognition service — CLIP for zero-shot classification.

DEPLOY: modal deploy pipeline.py
TEST:   modal run pipeline.py --input-path test.jpg
COST:   ~$0.001 per image (1-2s on T4 at $0.59/hr)
"""

import io
import json
import modal

app = modal.App("image-recognition")

volume = modal.Volume.from_name("ml-model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "torch>=2.1.0",
        "transformers>=4.36.0",
        "Pillow>=10.0.0",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
    )
)

DEFAULT_LABELS = [
    "a photo of a person",
    "a photo of an animal",
    "a photo of food",
    "a photo of a building",
    "a photo of a vehicle",
    "a photo of nature",
    "a photo of text or document",
    "a photo of electronics",
    "a photo of clothing",
    "a photo of art or painting",
    "a photo of a product",
    "a photo of furniture",
    "a photo of a sport",
    "a photo of a toy",
]


@app.function(
    gpu="T4",
    image=image,
    volumes={"/models": volume},
    timeout=60,
    container_idle_timeout=300,
)
def classify_image(
    image_bytes: bytes,
    labels: list[str] | None = None,
    top_k: int = 5,
) -> list[dict]:
    from transformers import CLIPProcessor, CLIPModel
    from PIL import Image

    model_name = "openai/clip-vit-large-patch14"
    cache_dir = "/models/clip"

    model = CLIPModel.from_pretrained(model_name, cache_dir=cache_dir)
    processor = CLIPProcessor.from_pretrained(model_name, cache_dir=cache_dir)

    pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    candidate_labels = labels or DEFAULT_LABELS

    inputs = processor(
        text=candidate_labels,
        images=pil_image,
        return_tensors="pt",
        padding=True,
    )

    outputs = model(**inputs)
    logits = outputs.logits_per_image[0]
    probs = logits.softmax(dim=0)

    results = []
    for label, prob in zip(candidate_labels, probs.tolist()):
        results.append({"label": label, "score": round(prob, 4)})

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:top_k]


@app.function(image=image, timeout=120)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    from starlette.responses import JSONResponse

    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        labels_raw = form.get("labels", None)
        top_k = int(form.get("top_k", "5"))
        if not file:
            return JSONResponse({"error": "No file uploaded"}, status_code=400)
        image_bytes = await file.read()
        labels = labels_raw.split(",") if labels_raw else None
    elif "application/json" in content_type:
        import base64
        body = await request.json()
        if "image_base64" not in body:
            return JSONResponse({"error": "Missing image_base64 field"}, status_code=400)
        image_bytes = base64.b64decode(body["image_base64"])
        labels = body.get("labels")
        top_k = body.get("top_k", 5)
    else:
        return JSONResponse({"error": "Unsupported content type"}, status_code=415)

    try:
        results = classify_image.remote(image_bytes, labels=labels, top_k=top_k)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    return JSONResponse({"results": results})


@app.local_entrypoint()
def main(input_path: str = "test.jpg"):
    with open(input_path, "rb") as f:
        image_bytes = f.read()

    print(f"Classifying {input_path}...")
    results = classify_image.remote(image_bytes)

    for r in results:
        bar = "#" * int(r["score"] * 40)
        print(f"  {r['score']:.3f} {bar} {r['label']}")
