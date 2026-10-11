ARG NODE_IMAGE=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG RUST_IMAGE=rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e

FROM ${NODE_IMAGE} AS sources
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY usdt/fetch-anvil.cjs usdt/pins.json ./
RUN node fetch-anvil.cjs

FROM ${RUST_IMAGE} AS wallet
RUN apt-get update && apt-get install -y --no-install-recommends \
    libudev-dev libdbus-1-dev pkg-config clang cmake protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt clippy
COPY core /build/core
WORKDIR /build/usdt/wallet
COPY usdt/wallet/Cargo.toml usdt/wallet/Cargo.lock ./
COPY usdt/wallet/src ./src
ENV CARGO_BUILD_JOBS=2
RUN cargo fmt --check && cargo build --locked \
    && cargo clippy --locked --all-targets --no-deps -- -D warnings \
    && install -Dm755 target/debug/usdt-fixture-wallet /out/usdt-fixture-wallet

FROM sources AS gateway-build
WORKDIR /src/service
COPY service ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS gateway
WORKDIR /app
COPY --from=gateway-build --chown=node:node /src/service/package.json ./
COPY --from=gateway-build --chown=node:node /src/service/node_modules ./node_modules
COPY --from=gateway-build --chown=node:node /src/service/dist ./dist
USER node
CMD ["node", "dist/index.js"]

FROM ${NODE_IMAGE} AS fixture
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libudev1 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY usdt/package.json usdt/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --from=sources /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=wallet /out/usdt-fixture-wallet /usr/local/bin/usdt-fixture-wallet
COPY usdt/*.cjs usdt/biome.json usdt/pins.json ./
RUN npm run lint && npm test && mkdir -p /state /home/node/.foundry && chown -R node:node /state /home/node/.foundry
USER node
CMD ["node", "server.cjs"]
