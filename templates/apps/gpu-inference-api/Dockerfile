# Multi-stage Dockerfile for the GPU inference API server.
#
# This container runs on Coolify (Hetzner VPS). It does NOT need a GPU.
# It receives photo uploads, dispatches GPU inference jobs to an external
# platform (Modal, RunPod, AWS Batch), and serves results.
#
# The GPU inference container is separate — see modal/ directory.

FROM python:3.11-slim-bookworm AS deps
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

FROM deps AS runtime
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
