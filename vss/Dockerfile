# The pinned synonymdev/vss-server tree (see .gitmodules). One cargo job and no
# release LTO, so the image builds on a small engine VM.
FROM rust:1.82-slim-bullseye AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY vss-server/rust/Cargo.toml vss-server/rust/Cargo.lock ./
COPY vss-server/rust/api/Cargo.toml ./api/
COPY vss-server/rust/auth-impls/Cargo.toml ./auth-impls/
COPY vss-server/rust/impls/Cargo.toml ./impls/
COPY vss-server/rust/server/Cargo.toml ./server/
COPY vss-server/rust/api/ ./api/
COPY vss-server/rust/auth-impls/ ./auth-impls/
COPY vss-server/rust/impls/ ./impls/
COPY vss-server/rust/server/ ./server/
COPY vss-server/proto/ ./proto/

ENV CARGO_BUILD_JOBS=1 \
    CARGO_PROFILE_RELEASE_LTO=false
RUN cargo build --release --bin vss-server

FROM debian:bullseye-slim

RUN apt-get update && apt-get install -y libssl1.1 libpq5 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /bin/false vss
WORKDIR /app
COPY --from=builder /build/target/release/vss-server /app/vss-server
COPY vss-server/rust/server/vss-server-config.toml /app/vss-server-config.toml
RUN chown -R vss:vss /app
USER vss
EXPOSE 5050
CMD ["./vss-server", "/app/vss-server-config.toml"]
