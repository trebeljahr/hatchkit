# Use a reviewed immutable image ID/digest that already includes runtime patches.
ARG COOLIFY_BASE
FROM ${COOLIFY_BASE} AS deployed
FROM python:3.14.9-alpine AS patcher
COPY --from=deployed /var/www/html/bootstrap/helpers/docker.php /docker.php
COPY patch-hardening.py /patch-hardening.py
RUN python3 /patch-hardening.py /docker.php
FROM deployed
USER root
COPY --from=patcher /docker.php /var/www/html/bootstrap/helpers/docker.php
COPY probe-hardening.php /tmp/hatchkit-probe-hardening.php
RUN php -l /var/www/html/bootstrap/helpers/docker.php \
 && php /tmp/hatchkit-probe-hardening.php \
 && rm /tmp/hatchkit-probe-hardening.php
LABEL io.hatchkit.security.original-image="ghcr.io/coollabsio/coolify:4.4.7"
LABEL io.hatchkit.security.run-options="1"

USER www-data
