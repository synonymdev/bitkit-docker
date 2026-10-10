# Paykit Server at a release tag, built with the classic builder (the QA boxes' Docker has no BuildKit, so no cache mounts or named
# contexts). The build fails when the tag is not at PAYKIT_SERVER_REV or its Cargo.lock does not lock paykit-rs at PAYKIT_RS_REV.
ARG RUST_IMAGE=rust:1.91.1-slim-bookworm@sha256:8514999d4786ef12efe89239e86b3d0a021b94b9d35108c8efe6c79ca7dc1a65
ARG RUNTIME_IMAGE=debian:bookworm-20260112-slim@sha256:56ff6d36d4eb3db13a741b342ec466f121480b5edded42e4b7ee850ce7a418ee

FROM ${RUST_IMAGE} AS builder
ARG PAYKIT_SERVER_TAG
ARG PAYKIT_SERVER_REV
ARG PAYKIT_RS_REV
ENV RUSTUP_TOOLCHAIN=1.91.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN git clone -q --depth 1 --branch "$PAYKIT_SERVER_TAG" https://github.com/pubky/paykit-server.git /build/paykit-server \
    && test "$(git -C /build/paykit-server rev-parse HEAD)" = "$PAYKIT_SERVER_REV" \
    && grep -Fq "git+https://github.com/pubky/paykit-rs.git?rev=$PAYKIT_RS_REV#$PAYKIT_RS_REV" /build/paykit-server/Cargo.lock
WORKDIR /build/paykit-server
RUN cargo build --locked --release -p paykit-server --bin paykit-server \
    && install -Dm755 target/release/paykit-server /out/paykit-server

FROM ${RUNTIME_IMAGE}
ARG PAYKIT_SERVER_TAG
ARG PAYKIT_SERVER_REV
ARG PAYKIT_RS_REV
LABEL org.opencontainers.image.revision="${PAYKIT_SERVER_REV}" \
      tech.masivo.paykit-server="${PAYKIT_SERVER_REV}" \
      tech.masivo.paykit-server-tag="${PAYKIT_SERVER_TAG}" \
      tech.masivo.paykit-rs="${PAYKIT_RS_REV}"
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/paykit-server /usr/local/bin/paykit-server
RUN groupadd --system --gid 10001 paykit && useradd --system --uid 10001 --gid paykit --create-home paykit
USER paykit:paykit
EXPOSE 3001
