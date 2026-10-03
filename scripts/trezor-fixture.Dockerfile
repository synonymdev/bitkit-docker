FROM ghcr.io/trezor/trezor-user-env@sha256:15871ebb234bf7c0197cfcd31ddc2edbe90173cd6386fc0283fafe05bf888c06

# Older ARM User Env images omit the runtime required by their bundled emulator.
RUN apt-get update && apt-get install -y --no-install-recommends libsdl3-0 libsdl3-image0 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY trezor-controller.py trezor-fixture.py /opt/bitkit-trezor/
WORKDIR /trezor-user-env
ENTRYPOINT ["/trezor-user-env/.venv/bin/python3", "/opt/bitkit-trezor/trezor-fixture.py"]
