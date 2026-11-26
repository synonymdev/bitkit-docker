# Blockstream Jade firmware under QEMU, for driving Bitkit's Jade flows without a device.
#
# Stage one builds the official firmware release in Blockstream's pinned builder (amd64 only).
# Stage two runs it on Espressif's qemu-xtensa for the host architecture: under Rosetta the
# amd64 QEMU never gets past the bootloader on Apple Silicon.

FROM --platform=linux/amd64 blockstream/jade_builder@sha256:8b739db85b6b99664db0e3ece57cddfa4e0fee4101a20ca930c391273f21e2f9 AS firmware

ARG JADE_VERSION=1.0.41
ARG JADE_COMMIT=dd45a7dc71b2dfe26e53980d6b1b46d809d58347
RUN git clone --depth 1 --branch "${JADE_VERSION}" --recurse-submodules --shallow-submodules \
      https://github.com/Blockstream/Jade /jade \
    && test "$(git -C /jade rev-parse HEAD)" = "${JADE_COMMIT}"
WORKDIR /jade
# A debug build never restricts the device to one network. Restrict it on PIN setup like a release
# build does, so a device set up for mainnet refuses a testnet app (network mismatch).
# PIN pads start every digit at 0 instead of a random value, so a script can type a PIN.
RUN sed -i 's|^#ifndef CONFIG_DEBUG_MODE$|#if 1 // bitkit-docker: restrict networks in debug builds too|' main/process/auth_user.c \
    && grep -q 'bitkit-docker: restrict networks' main/process/auth_user.c \
    && sed -i 's/\.initial_state = RANDOM/.initial_state = ZERO/' main/process/auth_user.c main/process/dashboard.c \
    && ! grep -q 'initial_state = RANDOM' main/process/auth_user.c main/process/dashboard.c
# auto: --ci enters PIN 012345 and confirms every on-device prompt by itself.
# interactive: --webdisplay serves the device screen and buttons on port 30122 and waits for input.
RUN cd /opt/esp/idf && . ./export.sh && cd /jade \
    && for mode in auto interactive; do \
         if [ "$mode" = auto ]; then flags="--ci"; else flags="--webdisplay"; fi \
         && ./tools/switch_to.sh qemu --dev --psram $flags \
         && rm -rf build && idf.py all \
         && mkdir -p /out/$mode \
         && ./main/qemu/make_flash_img.sh /out/$mode/flash_image.bin /out/$mode/qemu_efuse.bin \
         && { grep -E '^CONFIG_DISPLAY_(WIDTH|HEIGHT)=' sdkconfig > /out/$mode/display.env || true; } \
         || exit 1; \
       done

# old: release 1.0.33, before the taproot addresses Bitkit asks for (1.0.34), in its own builder.
FROM --platform=linux/amd64 blockstream/verde@sha256:c6b59066998c138c7e43a8bc12ed6f9e83ebe3476ab4c5b73619390c495ab948 AS firmware-old

ARG JADE_OLD_VERSION=1.0.33
ARG JADE_OLD_COMMIT=062ad45c560685bcaf9089f51255990f1916c883
RUN git clone --depth 1 --branch "${JADE_OLD_VERSION}" --recurse-submodules --shallow-submodules \
      https://github.com/Blockstream/Jade /jade \
    && test "$(git -C /jade rev-parse HEAD)" = "${JADE_OLD_COMMIT}"
WORKDIR /jade
RUN . /root/esp/esp-idf/export.sh \
    && cp configs/sdkconfig_qemu_psram.defaults sdkconfig.defaults \
    && idf.py build \
    && ./main/qemu/make-flash-img.sh \
    && mkdir -p /out/old && mv /flash_image.bin /qemu_efuse.bin /out/old/ \
    && { grep -E '^CONFIG_DISPLAY_(WIDTH|HEIGHT)=' sdkconfig > /out/old/display.env || true; }

FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e

ARG TARGETARCH
ARG QEMU_RELEASE=esp-develop-9.2.2-20250817
ARG QEMU_BUILD=esp_develop_9.2.2_20250817
ARG QEMU_SHA256_ARM64=317f6e0fd1dba0886d8110709823d909593ef29438822a14f81ebe19d72ce7cd
ARG QEMU_SHA256_AMD64=588bfaccd0f929650655d10a580f020c6ba9c131712d8fa519280081b8d126eb

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
       libglib2.0-0 libpixman-1-0 libslirp0 libsdl2-2.0-0 libgcrypt20 \
       python3 python3-cbor2 python3-serial python3-requests python3-websocket \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      arm64) arch=aarch64; sha="${QEMU_SHA256_ARM64}" ;; \
      amd64) arch=x86_64; sha="${QEMU_SHA256_AMD64}" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/qemu.tar.xz \
      "https://github.com/espressif/qemu/releases/download/${QEMU_RELEASE}/qemu-xtensa-softmmu-${QEMU_BUILD}-${arch}-linux-gnu.tar.xz" \
    && echo "${sha}  /tmp/qemu.tar.xz" | sha256sum -c - \
    && mkdir -p /opt/qemu && tar -xJf /tmp/qemu.tar.xz -C /opt/qemu --strip-components=1 \
    && rm /tmp/qemu.tar.xz

COPY --from=firmware /out/ /opt/jade/
COPY --from=firmware-old /out/ /opt/jade/
COPY --from=firmware /jade/jadepy /opt/bitkit-jade/jadepy
COPY jade-fixture.py /opt/bitkit-jade/

EXPOSE 30121 30122
ENTRYPOINT ["python3", "/opt/bitkit-jade/jade-fixture.py"]
