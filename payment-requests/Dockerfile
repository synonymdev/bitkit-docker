FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS builder
WORKDIR /usr/src/fixture
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY select-sdk-features.sh ./select-sdk-features.sh
# scripts/follow-app-paykit passes the paykit-rs commit an app pins; empty keeps the committed pin. The fixture's own pubky pin
# follows the one paykit-lib names at that commit (rc72 moved to Pubky 0.15), so their types stay one crate.
ARG PAYKIT_RS_REV=
RUN if [ -n "$PAYKIT_RS_REV" ]; then \
      sed -i -E "s|(paykit-rs.git\", rev = \")[0-9a-f]+|\1$PAYKIT_RS_REV|" Cargo.toml \
      && cargo update -p paykit-lib -p paykit-sdk \
      && pubky=$(sed -n 's/^pubky = "\(.*\)"$/\1/p' "$CARGO_HOME"/git/checkouts/paykit-rs-*/"$(echo "$PAYKIT_RS_REV" | cut -c1-7)"/paykit-lib/Cargo.toml) \
      && [ -n "$pubky" ] && sed -i -E "s|^pubky = \"[^\"]*\"|pubky = \"=$pubky\"|" Cargo.toml \
      && cargo update -p paykit-lib -p paykit-sdk; \
    fi
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/usr/src/fixture/target \
    cargo fetch --locked \
    && revision=$(sed -n 's|^source = "git+https://github.com/pubky/paykit-rs.git?rev=[0-9a-f]*#\([0-9a-f]*\)"|\1|p' Cargo.lock | sort -u) \
    && test "${#revision}" = 40 \
    && features=$(sh ./select-sdk-features.sh "$CARGO_HOME"/git/checkouts/paykit-rs-*/"$(printf '%s' "$revision" | cut -c1-7)"/paykit-sdk/src/runtime/payment_requests.rs) \
    && cargo build --release --locked $features && install -Dm755 target/release/bitkit-payment-request-fixture /out/fixture \
    && install -Dm755 target/release/homeserver-proxy /out/homeserver-proxy \
    && sed -n 's|^source = "git+https://github.com/pubky/paykit-rs.git?rev=[0-9a-f]*#\([0-9a-f]*\)"|\1|p' Cargo.lock | head -1 > /out/paykit-rs-rev

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/fixture /usr/local/bin/fixture
COPY --from=builder /out/homeserver-proxy /usr/local/bin/homeserver-proxy
COPY --from=builder /out/paykit-rs-rev /usr/local/share/paykit-rs-rev
ENTRYPOINT ["/usr/local/bin/fixture"]
