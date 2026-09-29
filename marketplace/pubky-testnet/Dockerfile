# Pubky Core static testnet (DHT, PKARR relay, HTTP relay, homeserver) for the
# marketplace fixture. Same build as pubky/locks docker/pubky-testnet.Dockerfile
# at ba49a777, pinned to the Pubky Core revision that Bitkit's local testnet
# client and Paykit Server 722ef268 (Pubky 0.11 grant auth) are exercised against.
FROM rust:1.89.0-bookworm AS builder

ARG PUBKY_CORE_REV=f68014c111af0458e6a321e2d87a12479bfb3218
WORKDIR /usr/src/pubky-core
RUN git clone --filter=blob:none https://github.com/pubky/pubky-core.git . \
    && git checkout --detach "${PUBKY_CORE_REV}"
# The pinned Pubky Core revision locks quinn-proto 0.11.14, affected by
# RUSTSEC-2026-0185. Keep this precise override until its lockfile advances.
RUN cargo update -p quinn-proto --precise 0.11.15 \
    && cargo build --release -p pubky-testnet --bin pubky-testnet

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/src/pubky-core/target/release/pubky-testnet /usr/local/bin/pubky-testnet
EXPOSE 6881 15411 15412 6286 6287 6288
CMD ["pubky-testnet"]
