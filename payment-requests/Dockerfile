FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS builder
WORKDIR /usr/src/fixture
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# scripts/follow-app-paykit passes the paykit-rs commit an app pins; empty keeps the committed pin
ARG PAYKIT_RS_REV=
RUN if [ -n "$PAYKIT_RS_REV" ]; then \
      sed -i -E "s|(paykit-rs.git\", rev = \")[0-9a-f]+|\1$PAYKIT_RS_REV|" Cargo.toml \
      && cargo update -p paykit-lib -p paykit-sdk; \
    fi
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/usr/src/fixture/target \
    cargo build --release --locked && install -Dm755 target/release/bitkit-payment-request-fixture /out/fixture \
    && install -Dm755 target/release/homeserver-proxy /out/homeserver-proxy \
    && sed -n 's|^source = "git+https://github.com/pubky/paykit-rs.git?rev=[0-9a-f]*#\([0-9a-f]*\)"|\1|p' Cargo.lock | head -1 > /out/paykit-rs-rev

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/fixture /usr/local/bin/fixture
COPY --from=builder /out/homeserver-proxy /usr/local/bin/homeserver-proxy
COPY --from=builder /out/paykit-rs-rev /usr/local/share/paykit-rs-rev
ENTRYPOINT ["/usr/local/bin/fixture"]
