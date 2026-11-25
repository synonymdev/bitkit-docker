# Blockstream Jade firmware under QEMU, for driving Bitkit's Jade flows without a device.
#
# Stage one builds the official firmware release in Blockstream's pinned builder (amd64 only).
# Stage two runs it on Espressif's qemu-xtensa for the host architecture: under Rosetta the
# amd64 QEMU never gets past the bootloader on Apple Silicon.

FROM --platform=linux/amd64 blockstream/jade_builder@sha256:8b739db85b6b99664db0e3ece57cddfa4e0fee4101a20ca930c391273f21e2f9 AS firmware

ARG JADE_VERSION=1.0.41
RUN git clone --depth 1 --branch "${JADE_VERSION}" --recurse-submodules --shallow-submodules \
      https://github.com/Blockstream/Jade /jade
WORKDIR /jade
# --ci auto-confirms every on-device prompt, PIN entry included; --webdisplay would turn that off.
RUN cd /opt/esp/idf && . ./export.sh && cd /jade \
    && ./tools/switch_to.sh qemu --dev --ci --psram \
    && idf.py all \
    && mkdir -p /out \
    && ./main/qemu/make_flash_img.sh /out/flash_image.bin /out/qemu_efuse.bin

FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e

ARG TARGETARCH
ARG QEMU_RELEASE=esp-develop-9.2.2-20250817
ARG QEMU_BUILD=esp_develop_9.2.2_20250817
ARG QEMU_SHA256_ARM64=317f6e0fd1dba0886d8110709823d909593ef29438822a14f81ebe19d72ce7cd
ARG QEMU_SHA256_AMD64=588bfaccd0f929650655d10a580f020c6ba9c131712d8fa519280081b8d126eb

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
       libglib2.0-0 libpixman-1-0 libslirp0 libsdl2-2.0-0 libgcrypt20 \
       python3 python3-cbor2 python3-serial python3-requests \
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
COPY --from=firmware /jade/jadepy /opt/bitkit-jade/jadepy
COPY jade-fixture.py /opt/bitkit-jade/

EXPOSE 30121
ENTRYPOINT ["python3", "/opt/bitkit-jade/jade-fixture.py"]
