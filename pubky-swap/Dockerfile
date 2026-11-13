FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS builder
# The LND backend compiles LND's protos.
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
# The pubky-swap commit bitkit-core's Pubky Swaps client pins (swap-common in its Cargo.toml).
ARG PUBKY_SWAP_REV=f45e204ee7646dc91983d90e4782d40760b6c72b
WORKDIR /usr/src/pubky-swap
RUN git init -q . && git fetch -q --depth 1 https://github.com/coreyphillips/pubky-swap "$PUBKY_SWAP_REV" \
    && git checkout -q FETCH_HEAD
# No cache mounts: the QA boxes build without BuildKit, and this image is built rarely.
RUN cargo build --release --locked -p swap-provider --features full \
    && install -Dm755 target/release/swap-provider /out/swap-provider
COPY keygen /usr/src/keygen
RUN cd /usr/src/keygen && cargo build --release --locked \
    && install -Dm755 target/release/pubky-swap-keygen /out/pubky-swap-keygen

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/ /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/pubky-swap-entrypoint
ENTRYPOINT ["/usr/local/bin/pubky-swap-entrypoint"]
