# Re-review the exact base digest and its compiled Go version before updating it.
ARG COREDNS_IMAGE=coredns/coredns@sha256:0a9d8c8ddf34347eb59aad9a8784f0710de88d6d112726d11d271f9bc6daca26
FROM ${COREDNS_IMAGE}
# Supply a verified current PUBLIC CA bundle, containing no distrusted roots.
# Never copy an entire host config directory or private keys into the context.
COPY --chmod=0444 ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
LABEL io.hatchkit.security.original-image="coredns/coredns:1.15.0"
