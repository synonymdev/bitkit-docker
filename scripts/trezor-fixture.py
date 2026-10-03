#!/usr/bin/env python3
"""Start the pinned User Env and initialize a disposable deterministic device."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request


READY = Path("/tmp/bitkit-trezor-ready")
CONTROLLER = Path(__file__).with_name("trezor-controller.py")


def healthy():
    if not READY.is_file():
        raise RuntimeError("deterministic setup has not finished")
    request = urllib.request.Request("http://127.0.0.1:21325/enumerate", data=b"")
    with urllib.request.urlopen(request, timeout=5) as response:
        devices = json.load(response)
    if not devices or not any(device.get("path") for device in devices):
        raise RuntimeError("Bridge has no emulator")
    status = subprocess.run(
        [sys.executable, str(CONTROLLER), "status"],
        check=True, capture_output=True, text=True, timeout=10,
    )
    status = json.loads(status.stdout)
    for component in ("bridge_status", "emulator_status"):
        if not status[component]["is_running"]:
            raise RuntimeError(f"{component} is stopped")


def main():
    if sys.argv[1:] == ["--health"]:
        healthy()
        return

    READY.unlink(missing_ok=True)
    # The image already carries the firmware and Bridge; no runtime download.
    server = subprocess.Popen(
        [sys.executable, "src/main.py"], start_new_session=True,
    )

    def stop(signum=None, frame=None):
        if server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
                server.wait(timeout=5)

    def terminate(signum, frame):
        stop()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(f"User Env exited with {server.returncode}")
            probe = subprocess.run(
                [sys.executable, str(CONTROLLER), "ping"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
            )
            if probe.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("User Env controller was not ready within 120 seconds")
        subprocess.run(
            [sys.executable, str(CONTROLLER), "setup"], check=True, timeout=120,
        )
        READY.touch()
        healthy()
        print("Deterministic Trezor emulator and Bridge are ready", flush=True)
        raise SystemExit(server.wait())
    finally:
        READY.unlink(missing_ok=True)
        stop()


if __name__ == "__main__":
    main()
