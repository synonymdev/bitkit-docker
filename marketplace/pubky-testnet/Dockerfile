# Pubky static testnet (DHT, PKARR relay, HTTP relay, homeserver) for the
# marketplace fixture, built from the published `pubky-testnet` crate with its
# own lockfile. The homeserver of this release answers the WebDAV-style `LOCK`
# and `UNLOCK` requests of the Pubky SDK's write locks (the Paykit SDK takes
# one before it writes shared state); the earlier Pubky Core pin answered 405.
FROM rust:1.98.1-bookworm AS builder

ARG PUBKY_TESTNET_VERSION=0.14.0
RUN cargo install pubky-testnet --version "${PUBKY_TESTNET_VERSION}" --locked --root /opt/pubky

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/pubky/bin/pubky-testnet /usr/local/bin/pubky-testnet
EXPOSE 6881 15411 15412 6286 6287 6288
CMD ["pubky-testnet"]
