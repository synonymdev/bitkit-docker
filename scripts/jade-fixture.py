#!/usr/bin/env python3
"""Run the Jade QEMU emulator as a deterministic Bitkit test device.

Startup copies the pristine firmware flash (unless JADE_WIPE=false keeps the last
one), boots QEMU, and on an uninitialised device loads JADE_MNEMONIC and sets a
PIN through Blockstream's pinserver. It then reboots the device, so Bitkit finds
it locked behind a PIN like a real Jade after power-on. The CI firmware enters PIN
012345 itself whenever one is asked for, and confirms every other prompt.

Subcommands, run inside the container:
  (none)        start and supervise QEMU
  --health      exit 0 once setup finished and QEMU runs
  status        print the device's version info
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time

sys.path.insert(0, "/opt/bitkit-jade")
from jadepy.jade import JadeAPI  # noqa: E402

FIRMWARE_DIR = "/opt/jade"
STATE_DIR = "/var/lib/jade"
FLASH = os.path.join(STATE_DIR, "flash_image.bin")
EFUSE = os.path.join(STATE_DIR, "qemu_efuse.bin")
SERIAL_LOG = os.path.join(STATE_DIR, "serial.log")
READY_FILE = "/tmp/jade-ready"
PORT = 30121
DEVICE = f"tcp:127.0.0.1:{PORT}"
BOOT_TIMEOUT_S = 120

qemu = None


def log(message):
    print(f"[jade-fixture] {message}", flush=True)


def start_qemu():
    global qemu
    qemu = subprocess.Popen(
        [
            "/opt/qemu/bin/qemu-system-xtensa", "-nographic",
            "-machine", "esp32", "-m", "4M",
            "-drive", f"file={FLASH},if=mtd,format=raw",
            "-nic", f"user,model=open_eth,id=lo0,hostfwd=tcp:0.0.0.0:{PORT}-:{PORT}",
            "-drive", f"file={EFUSE},if=none,format=raw,id=efuse",
            "-global", "driver=nvram.esp32.efuse,property=drive,value=efuse",
            "-serial", f"file:{SERIAL_LOG}", "-monitor", "none",
        ],
        stdin=subprocess.DEVNULL,
    )


def stop_qemu():
    if qemu and qemu.poll() is None:
        qemu.terminate()
        try:
            qemu.wait(timeout=10)
        except subprocess.TimeoutExpired:
            qemu.kill()
            qemu.wait()


def connect(timeout=BOOT_TIMEOUT_S):
    deadline = time.monotonic() + timeout
    while True:
        jade = JadeAPI.create_serial(device=DEVICE, timeout=30)
        try:
            jade.connect()
            jade.get_version_info()
            return jade
        except Exception as error:  # noqa: BLE001 - the port accepts before the firmware listens
            try:
                jade.disconnect()
            except Exception:  # noqa: BLE001
                pass
            if time.monotonic() > deadline:
                raise RuntimeError(f"Jade did not answer within {timeout}s: {error}") from error
            time.sleep(2)


def version_summary(info):
    keys = ("JADE_VERSION", "JADE_STATE", "JADE_HAS_PIN", "JADE_NETWORKS", "EFUSEMAC")
    return {key: info.get(key) for key in keys}


def setup():
    mnemonic = os.environ.get("JADE_MNEMONIC", "").strip()
    network = os.environ.get("JADE_NETWORK", "testnet")
    jade = connect()
    try:
        info = jade.get_version_info()
        if info["JADE_STATE"] != "UNINIT" or not mnemonic:
            log(f"device {version_summary(info)}; nothing to set up")
            return False
        jade.set_mnemonic(mnemonic)
        if not jade.auth_user(network):
            raise RuntimeError("PIN setup through the pinserver failed")
        log(f"loaded the mnemonic and set the PIN for {network}")
        return True
    finally:
        jade.disconnect()


def run():
    os.makedirs(STATE_DIR, exist_ok=True)
    if os.path.exists(READY_FILE):
        os.remove(READY_FILE)
    wipe = os.environ.get("JADE_WIPE", "true").lower() != "false"
    if wipe or not os.path.exists(FLASH):
        shutil.copyfile(os.path.join(FIRMWARE_DIR, "flash_image.bin"), FLASH)
        shutil.copyfile(os.path.join(FIRMWARE_DIR, "qemu_efuse.bin"), EFUSE)

    def on_signal(signum, _frame):
        stop_qemu()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    start_qemu()
    if setup():
        log("rebooting so the device starts locked")
        stop_qemu()
        start_qemu()
        jade = connect()
        log(f"device {version_summary(jade.get_version_info())}")
        jade.disconnect()

    open(READY_FILE, "w").close()
    log(f"ready on port {PORT}")
    sys.exit(qemu.wait())


def health():
    # Only the ready file and the process: the firmware serves one client at a time,
    # so connecting here would queue behind the app.
    if not os.path.exists(READY_FILE):
        return 1
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as cmdline:
                if b"qemu-system-xtensa" in cmdline.read():
                    return 0
        except OSError:
            continue
    return 1


def status():
    jade = connect(timeout=10)
    try:
        print(json.dumps(version_summary(jade.get_version_info())))
    finally:
        jade.disconnect()
    return 0


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    if command == "run":
        run()
    elif command == "--health":
        sys.exit(health())
    elif command == "status":
        sys.exit(status())
    else:
        sys.exit(f"unknown command '{command}'")
