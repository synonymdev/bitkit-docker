#!/usr/bin/env python3
"""Run the Jade QEMU emulator as a deterministic Bitkit test device.

Startup copies the pristine firmware flash (unless JADE_WIPE=false keeps the last
one), boots QEMU, and on an uninitialised device loads JADE_MNEMONIC and sets a
PIN through Blockstream's pinserver. It then reboots the device, so Bitkit finds
it locked behind a PIN like a real Jade after power-on.

JADE_MODE picks the firmware:
  auto          enters PIN 012345 itself and confirms every prompt (unattended runs)
  interactive   shows the device screen and waits for button presses on port 30122,
                so PINs (right or wrong) are typed and prompts confirmed with the
                commands below
  old           auto on firmware 1.0.33, too old for the taproot addresses Bitkit
                asks for

Subcommands, run inside the container:
  (none)        start and supervise QEMU
  --health      exit 0 once setup finished and QEMU runs
  status        print the device's version info
  press B...    press buttons in turn: left, right, click (wheel), front
  pin DIGITS    type a PIN on the device's PIN pad (interactive)
  screen PNG    save the device screen as a PNG (interactive)
"""

import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import zlib

sys.path.insert(0, "/opt/bitkit-jade")
from jadepy.jade import JadeAPI  # noqa: E402

MODE = os.environ.get("JADE_MODE", "auto")
FIRMWARE_DIR = f"/opt/jade/{MODE}"
STATE_DIR = "/var/lib/jade"
FLASH = os.path.join(STATE_DIR, "flash_image.bin")
EFUSE = os.path.join(STATE_DIR, "qemu_efuse.bin")
FLASH_MODE = os.path.join(STATE_DIR, "mode")
SERIAL_LOG = os.path.join(STATE_DIR, "serial.log")
READY_FILE = "/tmp/jade-ready"
PORT = 30121
DISPLAY_PORT = 30122
# WebSocket opcodes from Jade's main/qemu/qemu_display.c
BUTTONS = {"left": 1, "click": 2, "right": 3, "front": 4}
PROVIDE_DISPLAY = 0
BUTTON_GAP_S = 0.25
DRAIN_S = 1
PIN_PAD_TIMEOUT_S = 30
PIN_ADVANCE_TIMEOUT_S = 3
PIN_PRESS_ATTEMPTS = 3
BUTTON_ATTEMPTS = 3
BUTTON_ADVANCE_TIMEOUT_S = 3
FRAME_ATTEMPTS = 3
TIMEOUT_SCREEN = "/tmp/jade-timeout.png"
DEVICE = f"tcp:127.0.0.1:{PORT}"
BOOT_TIMEOUT_S = 120
SETTLE_S = 3

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
            "-nic", f"user,model=open_eth,id=lo0,hostfwd=tcp:0.0.0.0:{PORT}-:{PORT}"
            f",hostfwd=tcp:0.0.0.0:{DISPLAY_PORT}-:{DISPLAY_PORT}",
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


def display():
    import websocket  # python3-websocket

    return websocket.create_connection(f"ws://127.0.0.1:{DISPLAY_PORT}/ws", timeout=10)


def press(*names):
    ws = display()
    try:
        for name in names:
            ws.send_binary(bytes([BUTTONS[name]]))
            time.sleep(BUTTON_GAP_S)
        # Closing right after the last send drops presses QEMU has not read yet.
        time.sleep(DRAIN_S)
    finally:
        ws.close()


def is_green(pixel):
    r, g, b = pixel
    return g > 100 and r < 80 and b < 160


def pin_pad_state():
    """The PIN pad's active digit box and its pixels, or (None, None) while the pad is not on screen."""
    rows = frame()
    # The pad is six 35 px boxes between x 15 and 224, y 42 to 105; only the active one is filled green.
    # After a wrong PIN an "attempts remaining" line pushes the boxes about 15 px lower.
    # A green dashboard tile fills several of those boxes at once, so it does not count.
    for shift in range(0, 25, 3):
        filled = [
            box for box in range(6)
            if all(
                sum(is_green(rows[y + shift][x]) for x in range(15 + 35 * box + 6, 15 + 35 * box + 30)) >= 18
                for y in (48, 100)
            )
        ]
        if len(filled) == 1:
            box = filled[0]
            pixels = tuple(tuple(rows[y][15 + 35 * box:50 + 35 * box]) for y in range(42 + shift, 106 + shift))
            return box, pixels
    return None, None


def pin_pad_position():
    return pin_pad_state()[0]


def is_continue_screen():
    """True on a full-width green Continue bar at the bottom, as the device's "Incorrect PIN!" screen shows."""
    rows = frame()
    return all(sum(is_green(pixel) for pixel in rows[y]) >= 200 for y in (118, 128))


def press_each(*names):
    """Press buttons one at a time, pressing again when the screen shows no change.

    A busy host can drop a press, and the next ones then land on the wrong screen (a dropped
    front before right front opens Scan QR instead of Log Out). A press with no visible effect
    is retried, which for such a press only repeats nothing."""
    width, height = display_size()
    size = width * height * 2
    for name in names:
        before = read_display(size)
        for attempt in range(BUTTON_ATTEMPTS):
            press(name)
            deadline = time.monotonic() + BUTTON_ADVANCE_TIMEOUT_S
            while read_display(size) == before and time.monotonic() < deadline:
                time.sleep(0.25)
            if read_display(size) != before:
                break
            if attempt < BUTTON_ATTEMPTS - 1:
                log(f"'{name}' left the device screen unchanged; pressing again")
        else:
            log(f"'{name}' left the device screen unchanged after {BUTTON_ATTEMPTS} presses")


def screen_check(condition):
    # A busy host can stall the display socket for a moment; that only means not ready yet.
    import websocket  # python3-websocket

    try:
        return condition()
    except (OSError, websocket.WebSocketException) as error:
        log(f"device screen unreadable, retrying: {error}")
        return False


def wait_for(condition, timeout_s, what):
    deadline = time.monotonic() + timeout_s
    while not screen_check(condition):
        if time.monotonic() > deadline:
            screen(TIMEOUT_SCREEN)
            raise RuntimeError(f"timed out waiting for {what}; the device screen is in {TIMEOUT_SCREEN}")
        time.sleep(0.5)


def type_pin(pin):
    # The patched PIN pad starts every digit at 0: step right to the digit, then select it.
    # Each digit waits for its own box, so no press lands before the pad shows or while it moves on.
    # A wrong PIN before leaves the "Incorrect PIN!" screen up until Continue, so that is pressed first.
    def pad_ready(index):
        if index == 0 and is_continue_screen():
            press("front")
            return False
        return pin_pad_position() == index

    for index, digit in enumerate(pin):
        what = f"PIN digit {index + 1} on the device"
        wait_for(lambda: pad_ready(index), PIN_PAD_TIMEOUT_S, what)
        _, before = pin_pad_state()
        for _attempt in range(PIN_PRESS_ATTEMPTS):
            press(*(["right"] * int(digit) + ["front"]))
            deadline = time.monotonic() + PIN_ADVANCE_TIMEOUT_S
            position, pixels = pin_pad_state()
            while position == index and time.monotonic() < deadline:
                time.sleep(0.25)
                position, pixels = pin_pad_state()
            if position != index:
                break
            # A pad that just appeared can drop presses; press again only when none registered.
            if pixels != before:
                screen(TIMEOUT_SCREEN)
                raise RuntimeError(f"{what} took only part of its presses; the screen is in {TIMEOUT_SCREEN}")
            log(f"{what} ignored its presses; pressing again")
        else:
            screen(TIMEOUT_SCREEN)
            raise RuntimeError(f"{what} ignored {PIN_PRESS_ATTEMPTS} presses; the screen is in {TIMEOUT_SCREEN}")


def frame():
    """The display as rows of (r, g, b) tuples."""
    import websocket  # python3-websocket

    width, height = display_size()
    # A busy host can stall the display socket for a moment, so a read is retried before it fails.
    for attempt in range(FRAME_ATTEMPTS):
        try:
            pixels = read_display(width * height * 2)
            break
        except (OSError, websocket.WebSocketException) as error:
            if attempt == FRAME_ATTEMPTS - 1:
                raise
            log(f"device screen unreadable, retrying: {error}")
            time.sleep(1)
    rows = []
    for y in range(height):
        row = []
        for x in range(width):
            # RGB565, high byte first as the device's display buffer holds it
            hi, lo = pixels[(y * width + x) * 2], pixels[(y * width + x) * 2 + 1]
            value = (hi << 8) | lo
            row.append(((value >> 11 & 0x1F) * 255 // 31, (value >> 5 & 0x3F) * 255 // 63, (value & 0x1F) * 255 // 31))
        rows.append(row)
    return rows


def read_display(size):
    ws = display()
    try:
        ws.send_binary(bytes([PROVIDE_DISPLAY]))
        pixels = bytearray()
        while len(pixels) < size:
            pixels += ws.recv()[1:]
        return pixels
    finally:
        ws.close()


def screen(path):
    rows = frame()
    height, width = len(rows), len(rows[0])
    data = b"".join(b"\x00" + bytes(channel for pixel in row for channel in pixel) for row in rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    with open(path, "wb") as out:
        out.write(b"\x89PNG\r\n\x1a\n")
        out.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
        out.write(chunk(b"IDAT", zlib.compress(data)))
        out.write(chunk(b"IEND", b""))


# The Manual passphrase keyboard: a 10x3 grid the right button steps through in order, wrapping.
KEYBOARD = list("abcdefghijklmnopqrstuvwxyz ") + ["delete", "more", "done"]


def highlighted_key():
    """Index in KEYBOARD of the key the device highlights (green), or None off the keyboard."""
    points = [(x, y) for y, row in enumerate(frame()) if y >= 40 for x, (r, g, b) in enumerate(row) if g > 120 and r < 60 and b < 160]
    # One key is about 20 x 22 px; a larger green area is another screen, such as a dashboard tile.
    if not points or len(points) > 900:
        return None
    x = sum(p[0] for p in points) / len(points)
    y = sum(p[1] for p in points) / len(points)
    return round((y - 69) / 25) * 10 + round((x - 17) / 22.6)


def select_key(index):
    for _ in range(5):
        current = highlighted_key()
        if current is None:
            raise RuntimeError("the passphrase keyboard is not on screen")
        if current == index:
            press("front")
            return
        press(*(["right"] * ((index - current) % len(KEYBOARD))))
    raise RuntimeError(f"could not reach the {KEYBOARD[index]!r} key")


def type_passphrase(text):
    # Reads the highlighted key from the screen before each step, so a lost press is corrected.
    unsupported = sorted(set(text) - set(KEYBOARD[:27]))
    if unsupported:
        raise SystemExit(f"passphrase supports lowercase letters and spaces only, not {''.join(unsupported)!r}")
    wait_for(lambda: highlighted_key() is not None, PIN_PAD_TIMEOUT_S, "the passphrase keyboard on the device")
    for char in text:
        select_key(KEYBOARD.index(char))
    select_key(KEYBOARD.index("done"))
    # Confirm Passphrase opens with No selected.
    press("right", "front")


def display_size():
    values = {}
    with open(os.path.join(FIRMWARE_DIR, "display.env")) as env:
        for line in env:
            key, _, value = line.strip().partition("=")
            values[key] = int(value)
    return values["CONFIG_DISPLAY_WIDTH"], values["CONFIG_DISPLAY_HEIGHT"]


def later(delay_s, action):
    def run_action():
        time.sleep(delay_s)
        try:
            action()
        except Exception as error:
            log(f"device input failed: {error}")

    threading.Thread(target=run_action, daemon=True).start()


def setup():
    mnemonic = os.environ.get("JADE_MNEMONIC", "").strip()
    network = os.environ.get("JADE_NETWORK", "testnet")
    jade = connect()
    try:
        info = jade.get_version_info()
        if info["JADE_STATE"] != "UNINIT" or not mnemonic:
            log(f"device {version_summary(info)}; nothing to set up")
            return False
        if MODE == "interactive":
            # The device shows a "debug wallet" warning before it takes the mnemonic.
            later(3, lambda: press("front"))
        jade.set_mnemonic(mnemonic)
        if MODE == "interactive":
            # The device asks for the new PIN, then for it again, while auth_user waits.
            pin = os.environ.get("JADE_PIN", "012345")
            later(3, lambda: (type_pin(pin), time.sleep(2), type_pin(pin)))
        if not jade.auth_user(network):
            raise RuntimeError("PIN setup through the pinserver failed")
        log(f"loaded the mnemonic and set the PIN for {network}")
        # A mainnet device unlocks once more through the default pinserver first, so it switches after that.
        if network != "mainnet":
            point_at_pinserver(jade)
        return True
    finally:
        jade.disconnect()


def point_at_pinserver(jade):
    url = os.environ.get("JADE_PINSERVER_URL", "").strip()
    if not url:
        return
    if MODE == "interactive":
        # "Confirm Oracle" starts on the back arrow; the checkmark to its right keeps the new pinserver.
        later(3, lambda: press("right", "front"))
    jade.set_pinserver(urlA=url)
    log(f"pointed the device at pinserver {url}")


def ask_for_passphrase():
    # From the locked dashboard: Options, BIP39 Passphrase, Frequency, Always Ask, then back out.
    # The firmware has no RPC for this setting. Method stays on its default, Manual, which `passphrase` types on.
    for step in (("right", "right", "front"), ("right", "front"), ("right", "right", "front"),
                 ("right", "right", "front"), ("left", "left", "front"), ("left", "front")):
        press(*step)
    log("set the device to ask for a passphrase at every unlock")


def reboot():
    log("rebooting so the device starts locked")
    stop_qemu()
    start_qemu()


def restrict_to_mainnet():
    # The firmware stores a network restriction only when a device that already has a PIN
    # unlocks, so the first PIN setup leaves it open; one more unlock pins it to mainnet, after
    # which a testnet app gets "network type inconsistent" like a real mainnet Jade.
    jade = connect()
    try:
        if MODE == "interactive":
            later(3, lambda: type_pin(os.environ.get("JADE_PIN", "012345")))
        if not jade.auth_user("mainnet"):
            raise RuntimeError("Unlocking for mainnet failed")
        # The device replies before it writes the restriction to flash.
        time.sleep(SETTLE_S)
        log("restricted the device to mainnet")
        point_at_pinserver(jade)
    finally:
        jade.disconnect()


def run():
    os.makedirs(STATE_DIR, exist_ok=True)
    if os.path.exists(READY_FILE):
        os.remove(READY_FILE)
    wipe = os.environ.get("JADE_WIPE", "true").lower() != "false"
    # A kept flash only boots on the firmware that wrote it, so a mode change wipes it.
    kept_mode = open(FLASH_MODE).read() if os.path.exists(FLASH_MODE) else None
    if wipe or kept_mode != MODE or not os.path.exists(FLASH):
        if not wipe and kept_mode and kept_mode != MODE:
            log(f"wiping the kept flash: it was written by mode {kept_mode}, not {MODE}")
        shutil.copyfile(os.path.join(FIRMWARE_DIR, "flash_image.bin"), FLASH)
        shutil.copyfile(os.path.join(FIRMWARE_DIR, "qemu_efuse.bin"), EFUSE)
        with open(FLASH_MODE, "w") as marker:
            marker.write(MODE)

    def on_signal(signum, _frame):
        stop_qemu()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    start_qemu()
    if setup():
        reboot()
        if os.environ.get("JADE_NETWORK", "testnet") == "mainnet":
            restrict_to_mainnet()
            reboot()
        jade = connect()
        log(f"device {version_summary(jade.get_version_info())}")
        jade.disconnect()
        if MODE == "interactive" and os.environ.get("JADE_PASSPHRASE") == "always":
            ask_for_passphrase()

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


USAGE = "usage: jade-emulator press <left|click|right|front>... | pin <digits> | passphrase <text> | screen <png>"

if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    args = sys.argv[2:]
    if command in ("pin", "passphrase", "screen") and len(args) != 1:
        sys.exit(USAGE)
    if command == "press" and (not args or set(args) - set(BUTTONS)):
        sys.exit(USAGE)
    if command in ("press", "pin", "passphrase", "screen") and MODE != "interactive":
        sys.exit(f"'{command}' needs the device screen, which only JADE_MODE=interactive serves")
    if command == "run":
        run()
    elif command == "--health":
        sys.exit(health())
    elif command == "status":
        sys.exit(status())
    elif command == "press":
        press_each(*sys.argv[2:])
    elif command == "pin":
        type_pin(sys.argv[2])
    elif command == "passphrase":
        type_passphrase(sys.argv[2])
    elif command == "screen":
        screen(sys.argv[2])
    else:
        sys.exit(f"unknown command '{command}'")
