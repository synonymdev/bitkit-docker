FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Helper binaries from the pinned Paykit Server image: the watch-only companion
# approval (the wallet's role in the setup flow) and the reader demo (a headless
# buyer). Both are Debian bookworm builds, the same base as this image.
COPY --from=paykit /usr/local/bin/paykit-companion-auth /usr/local/bin/paykit-reader-demo /usr/local/bin/
# The helpers build their HTTP clients from the system CA store.
COPY --from=paykit /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# Paykit Server rc65 accepts a setup claim only after the identity published its Paykit noise key authorization; the payment request
# fixture binary publishes it for the headless seller under this name (a Bitkit wallet does it in its own Paykit setup).
COPY --from=fixture /usr/local/bin/fixture /usr/local/bin/paykit-key-authorization
COPY driver.mjs trust.mjs ./
