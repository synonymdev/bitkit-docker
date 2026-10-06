FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS builder
WORKDIR /usr/src/fixture
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/usr/src/fixture/target \
    cargo build --release --locked && install -Dm755 target/release/bitkit-payment-request-fixture /out/fixture \
    && install -Dm755 target/release/homeserver-proxy /out/homeserver-proxy

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/fixture /usr/local/bin/fixture
COPY --from=builder /out/homeserver-proxy /usr/local/bin/homeserver-proxy
ENTRYPOINT ["/usr/local/bin/fixture"]
