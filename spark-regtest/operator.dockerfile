# The Spark operator: the last public commit of Breez's mirror of Lightspark's operator, with one patch.
# - operator-status-filter.patch: skip tree node statuses the operator does not know. SDK 0.27 and later ask for
#   TREE_NODE_STATUS_RETURNED, which this operator never stores, and without it fails the whole query, so wallet sync
#   fails.
# Built like breez/spark-sdk's crates/spark-itest/docker/spark-so.dockerfile at 7b6124227, whose entrypoint and
# config come in through the `itest` context. migrations.dockerfile pins the same commit.
ARG USER=so
ARG VERSION=b54845c68118197124c53eff5d0fa2db4338e3b5
ARG REPOSITORY=https://github.com/breez/spark.git

FROM debian:bookworm-20250721-slim AS downloader

ARG VERSION
ARG REPOSITORY

WORKDIR /source/

RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
        ca-certificates \
        git

RUN git init && \
    git remote add origin "$REPOSITORY" && \
    git fetch --depth 1 origin "$VERSION" && \
    git checkout FETCH_HEAD

COPY operator-status-filter.patch /tmp/
RUN git apply /tmp/operator-status-filter.patch


FROM golang:1.27.0-bookworm AS operator-builder

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
    libzmq3-dev

WORKDIR /app/spark
COPY --from=downloader /source/spark/go.mod /source/spark/go.sum ./
RUN go mod download

WORKDIR /app
COPY --from=downloader /source/ ./

WORKDIR /app/spark
RUN go build ./bin/operator


FROM rust:1.89.0-bookworm AS signer-builder

RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
        protobuf-compiler \
        libprotobuf-dev

WORKDIR /app
COPY --from=downloader /source/signer/ ./
COPY --from=downloader /source/protos/ /protos/
WORKDIR /app/spark-frost-signer
RUN cargo install --path .


FROM debian:bookworm-20250721-slim AS final

ARG USER

RUN adduser --disabled-password \
            --home "/data" \
            --gecos "" \
            "$USER"

RUN apt-get update -qq && \
    apt-get install -qq -y --no-install-recommends \
        postgresql-client \
        libzmq3-dev \
        sed \
        openssl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=itest entrypoint.sh /
RUN chmod +x /entrypoint.sh

RUN mkdir -p /data/ && chown -R $USER:$USER /data/
RUN mkdir -p /config/ && chown -R $USER:$USER /config/

USER $USER

EXPOSE 8535

COPY --from=itest so.config.yaml /config/
COPY --from=operator-builder /app/spark/operator /bin/
COPY --from=signer-builder /usr/local/cargo/bin/spark-frost-signer /bin/

ENTRYPOINT ["/entrypoint.sh"]
