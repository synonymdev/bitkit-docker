FROM ghcr.io/trezor/trezor-user-env@sha256:15871ebb234bf7c0197cfcd31ddc2edbe90173cd6386fc0283fafe05bf888c06

COPY trezor-controller.py trezor-fixture.py trezor-fixture-check.py /opt/bitkit-trezor/
WORKDIR /trezor-user-env
ENTRYPOINT ["/trezor-user-env/.venv/bin/python3", "/opt/bitkit-trezor/trezor-fixture.py"]
