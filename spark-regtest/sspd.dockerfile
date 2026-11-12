# The Spark service provider from breez/spark-sdk 7b6124227, the last spark-sdk commit built on the public operator
# (operator.dockerfile), which a newer SSP cannot talk to. The `sdk` context is that commit.
# - sspd-silent-payment-proof.patch: breez/spark-sdk ce29ca045, which adds the `silent_payment_proof` field on
#   CoopExitRequest (always null). Spark SDK 0.28 asks for it, and the SSP without it rejects the query.
FROM rust:1.88 AS builder

RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
        git \
        protobuf-compiler \
        libprotobuf-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=sdk . .
COPY sspd-silent-payment-proof.patch /tmp/
RUN git apply /tmp/sspd-silent-payment-proof.patch
RUN cargo build --release --locked -p sspd -p ssp-cli

FROM debian:bookworm-slim

RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/sspd /usr/local/bin/sspd
COPY --from=builder /app/target/release/ssp-cli /usr/local/bin/ssp-cli

ENTRYPOINT ["sspd"]
