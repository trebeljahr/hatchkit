# Supply an inspected official Python Alpine image digest.
ARG PYTHON_BASE
FROM ${PYTHON_BASE}
USER root
RUN apk update && apk upgrade --no-cache && update-ca-certificates
COPY --chmod=0444 discovery.py /app/discovery.py
RUN chmod 0755 /app && chmod 0444 /app/discovery.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
LABEL io.hatchkit.security.original-image="python:3.14.9-alpine"
USER 65532:65532
ENTRYPOINT ["python3", "/app/discovery.py"]
