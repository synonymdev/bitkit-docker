# Caddy with the layer4 app, so one process serves HTTPS and Electrum over TLS on 9999 with the same certificates.
FROM caddy:2.11.4-builder AS builder
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.4
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
