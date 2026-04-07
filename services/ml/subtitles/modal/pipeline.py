"""
Subtitle generation service — OpenAI Whisper large-v3.

DEPLOY: modal deploy pipeline.py
TEST:   modal run pipeline.py --input-path test.mp3
COST:   ~$0.02 per minute of audio (on A10G at $1.10/hr)
"""

import io
import json
import tempfile
import modal

app = modal.App("subtitle-generator")

volume = modal.Volume.from_name("ml-model-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "openai-whisper>=20231117",
        "torch>=2.1.0",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
    )
)


def format_srt(segments: list[dict]) -> str:
    """Convert Whisper segments to SRT format."""
    lines = []
    for i, seg in enumerate(segments, 1):
        start = _format_timestamp(seg["start"])
        end = _format_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)


def format_vtt(segments: list[dict]) -> str:
    """Convert Whisper segments to WebVTT format."""
    lines = ["WEBVTT\n"]
    for seg in segments:
        start = _format_timestamp(seg["start"], vtt=True)
        end = _format_timestamp(seg["end"], vtt=True)
        text = seg["text"].strip()
        lines.append(f"{start} --> {end}\n{text}\n")
    return "\n".join(lines)


def _format_timestamp(seconds: float, vtt: bool = False) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    sep = "." if vtt else ","
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


@app.function(
    gpu="A10G",
    image=image,
    volumes={"/models": volume},
    timeout=300,
    container_idle_timeout=300,
)
def transcribe(
    audio_bytes: bytes,
    language: str | None = None,
    model_size: str = "large-v3",
) -> dict:
    import whisper

    model_path = f"/models/whisper-{model_size}"
    model = whisper.load_model(model_size, download_root="/models")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()

        options = {}
        if language:
            options["language"] = language

        result = whisper.transcribe(model, tmp.name, **options)

    segments = [
        {
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
        }
        for seg in result["segments"]
    ]

    return {
        "text": result["text"],
        "language": result.get("language", language or "auto"),
        "segments": segments,
        "srt": format_srt(segments),
        "vtt": format_vtt(segments),
    }


@app.function(image=image, timeout=360)
@modal.web_endpoint(method="POST")
async def api(request: modal.web_endpoint.Request):
    from starlette.responses import JSONResponse, Response

    content_type = request.headers.get("content-type", "")

    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        language = form.get("language", None)
        model_size = form.get("model", "large-v3")
        output_format = form.get("format", "json")
        if not file:
            return JSONResponse({"error": "No file uploaded"}, status_code=400)
        audio_bytes = await file.read()
    elif "application/json" in content_type:
        import base64
        body = await request.json()
        if "audio_base64" not in body:
            return JSONResponse({"error": "Missing audio_base64 field"}, status_code=400)
        audio_bytes = base64.b64decode(body["audio_base64"])
        language = body.get("language")
        model_size = body.get("model", "large-v3")
        output_format = body.get("format", "json")
    else:
        return JSONResponse({"error": "Unsupported content type"}, status_code=415)

    try:
        result = transcribe.remote(audio_bytes, language=language, model_size=model_size)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

    if output_format == "srt":
        return Response(
            content=result["srt"],
            media_type="text/plain",
            headers={"Content-Disposition": "attachment; filename=subtitles.srt"},
        )
    elif output_format == "vtt":
        return Response(
            content=result["vtt"],
            media_type="text/vtt",
            headers={"Content-Disposition": "attachment; filename=subtitles.vtt"},
        )
    else:
        return JSONResponse({
            "text": result["text"],
            "language": result["language"],
            "segments": result["segments"],
        })


@app.local_entrypoint()
def main(input_path: str = "test.mp3"):
    with open(input_path, "rb") as f:
        audio_bytes = f.read()

    print(f"Transcribing {input_path}...")
    result = transcribe.remote(audio_bytes)

    print(f"Language: {result['language']}")
    print(f"Segments: {len(result['segments'])}")
    print(f"\n{result['text'][:500]}...")

    srt_path = input_path.rsplit(".", 1)[0] + ".srt"
    with open(srt_path, "w") as f:
        f.write(result["srt"])
    print(f"\nSaved {srt_path}")
