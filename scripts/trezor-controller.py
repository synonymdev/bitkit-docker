#!/usr/bin/env python3
"""Small client for the Trezor User Env websocket controller.

The shell helper runs this file inside the User Env container so the host does
not need a Python websocket package installed.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any

import websockets


CONTROLLER_WS = os.environ.get("TREZOR_CONTROLLER_WS", "ws://127.0.0.1:9001")
DEFAULT_MNEMONIC = "all all all all all all all all all all all all"


def next_id() -> int:
    next_id.value += 1
    return next_id.value


next_id.value = 0


async def send(
    payload: dict[str, Any], *, allow_failure: bool = False, quiet: bool = False
) -> dict[str, Any]:
    async with websockets.connect(CONTROLLER_WS) as websocket:
        await websocket.recv()
        await websocket.send(json.dumps(payload))
        raw_response = await websocket.recv()

    response = json.loads(raw_response)
    if not quiet:
        print(json.dumps(response, indent=2, sort_keys=True))

    if not allow_failure and not response.get("success", False):
        raise RuntimeError(response.get("error", response))

    return response


async def setup() -> None:
    await send(
        {
            "type": "bridge-start",
            "version": os.environ.get("TREZOR_BRIDGE_VERSION", "node-bridge"),
            "id": next_id(),
        }
    )
    await send(
        {
            "type": "emulator-start",
            "model": os.environ.get("TREZOR_MODEL", "T2T1"),
            "version": os.environ.get("TREZOR_FIRMWARE", "2-main"),
            "wipe": os.environ.get("TREZOR_WIPE", "true").lower() != "false",
            "id": next_id(),
        }
    )
    await send(
        {
            "type": "emulator-setup",
            "mnemonic": os.environ.get("TREZOR_MNEMONIC", DEFAULT_MNEMONIC),
            "pin": os.environ.get("TREZOR_PIN", ""),
            "passphrase_protection": os.environ.get(
                "TREZOR_PASSPHRASE_PROTECTION", "false"
            ).lower()
            == "true",
            "label": os.environ.get("TREZOR_LABEL", "Bitkit Test Trezor"),
            "needs_backup": os.environ.get("TREZOR_NEEDS_BACKUP", "false").lower()
            == "true",
            "id": next_id(),
        }
    )
    await status()


async def status() -> None:
    await send({"type": "background-check", "id": next_id()})


async def stop() -> None:
    await send({"type": "emulator-stop", "id": next_id()}, allow_failure=True)
    await send({"type": "bridge-stop", "id": next_id()}, allow_failure=True)
    await status()


async def raw(payload: str) -> None:
    parsed = json.loads(payload)
    parsed.setdefault("id", next_id())
    await send(parsed)


def bridge_client():
    from trezorlib.client import get_default_client
    from trezorlib.transport.bridge import BridgeTransport

    transport = None
    for _ in range(30):
        transport = next(iter(BridgeTransport.enumerate()), None)
        if transport is not None:
            break
        time.sleep(1)

    if transport is None:
        raise SystemExit("No Trezor Bridge device found.")

    return get_default_client("bitkit-e2e", transport)


def lock() -> None:
    """Lock the device, so the next app request asks for its PIN."""
    with bridge_client() as client:
        client.lock()
    print("Device locked behind its PIN.")


async def pin(value: str) -> None:
    """Enter a PIN the device is asking for.

    T2T1 and T3T1 take the PIN on their own screen, so the debug link types it.
    T1B1 takes it in the app's scrambled matrix, so print the keys to tap there.
    """
    check = await send({"type": "background-check", "id": next_id()}, quiet=True)
    model = check["emulator_status"]["version"] or ""

    if "T1B1" in model:
        state = await send({"type": "emulator-get-debug-state", "id": next_id()}, quiet=True)
        matrix = state["response"].get("matrix")
        if sorted(matrix or "") != list("123456789"):
            # The firmware clears its matrix once the app answers.
            raise SystemExit("The device shows no PIN matrix.")
        if not value.isdigit() or "0" in value:
            raise SystemExit("A T1B1 PIN uses the digits 1-9.")
        keys = " ".join(str(matrix.index(digit) + 1) for digit in value)
        print(f"Tap these keys in the app's PIN matrix (7 8 9 top row, 1 2 3 bottom row): {keys}")
        return

    async def keyboard() -> str | None:
        """The PIN keyboard's digit order, or None when no PIN keyboard shows."""
        state = await send({"type": "emulator-get-debug-state", "id": next_id()}, quiet=True)
        for token in state["response"].get("tokens") or []:
            component = json.loads(token)
            if component.get("component") == "PinKeyboard":
                return component["digits_order"]
        return None

    shown = await keyboard()
    if shown is None:
        raise SystemExit("The device is not asking for a PIN.")
    await send({"type": "emulator-input", "value": value, "id": next_id()}, quiet=True)
    for _ in range(20):
        time.sleep(0.5)
        now = await keyboard()
        if now is None:
            print("PIN accepted.")
            return
        if now != shown:
            # A wrong PIN brings up a freshly shuffled keyboard.
            print("PIN rejected: the device asks for it again.")
            return
    raise SystemExit("The device did not answer the PIN.")


def get_address() -> None:
    from trezorlib import btc, messages
    from trezorlib.tools import parse_path

    coin = os.environ.get("TREZOR_ADDRESS_COIN", "Regtest")
    path = os.environ.get("TREZOR_ADDRESS_PATH", "m/84h/1h/0h/0/0").replace("h", "'")

    with bridge_client() as client:
        if client.features.unlocked is False:
            raise SystemExit("The device is locked behind its PIN; unlock it first.")
        session = client.get_session()
        address = btc.get_address(
            session,
            coin,
            parse_path(path),
            show_display=False,
            script_type=messages.InputScriptType.SPENDWITNESS,
        )

    print(address)


async def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "setup"

    if command == "ping":
        await send({"type": "ping", "id": next_id()})
    elif command == "setup":
        await setup()
    elif command == "status":
        await status()
    elif command == "stop":
        await stop()
    elif command == "send-json":
        if len(sys.argv) != 3:
            raise SystemExit("send-json expects one JSON payload argument")
        await raw(sys.argv[2])
    elif command == "get-address":
        get_address()
    elif command == "lock":
        lock()
    elif command == "pin":
        if len(sys.argv) != 3:
            raise SystemExit("pin expects one PIN argument")
        await pin(sys.argv[2])
    else:
        raise SystemExit(f"Unknown controller command: {command}")


if __name__ == "__main__":
    asyncio.run(main())
