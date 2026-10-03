#!/usr/bin/env python3
"""Check the fixture through Bridge without an app or a live chain.

Uses the public test seed and a synthetic previous transaction. Debug-link
approval is confined to this check; normal signing still needs a runner's input.
"""

import hashlib
import hmac
import json
import signal
import struct

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from trezorlib import btc, messages
from trezorlib.debuglink import TrezorTestContext
from trezorlib.tools import parse_path
from trezorlib.transport.bridge import BridgeTransport
from trezorlib.transport.udp import UdpTransport


def sha256d(data):
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def hash160(data):
    return hashlib.new("ripemd160", hashlib.sha256(data).digest()).digest()


def compressed_public_key(secret):
    key = ec.derive_private_key(secret, ec.SECP256K1()).public_key().public_numbers()
    return bytes([2 + key.y % 2]) + key.x.to_bytes(32, "big")


def expected_public_key(path):
    seed = hashlib.pbkdf2_hmac("sha512", b"all all all all all all all all all all all all", b"mnemonic", 2048)
    material = hmac.digest(b"Bitcoin seed", seed, "sha512")
    secret, chain = int.from_bytes(material[:32], "big"), material[32:]
    order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    for index in path:
        parent = b"\0" + secret.to_bytes(32, "big") if index & 0x80000000 else compressed_public_key(secret)
        material = hmac.digest(chain, parent + struct.pack(">I", index), "sha512")
        secret = (secret + int.from_bytes(material[:32], "big")) % order
        chain = material[32:]
    return compressed_public_key(secret)


def timeout(signum, frame):
    raise TimeoutError("fixture check exceeded 90 seconds")


def main():
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(90)
    transports = BridgeTransport.enumerate()
    if len(transports) != 1:
        raise RuntimeError(f"expected one emulator, got {len(transports)}")
    path = parse_path("m/84h/1h/0h/0/0")
    destination_path = parse_path("m/84h/1h/0h/0/1")
    with TrezorTestContext(transports[0], debug_transport=UdpTransport("127.0.0.1:21325")) as context:
        with context.get_session() as session:
            features = session.features
            assert features.initialized and features.label == "Bitkit Test Trezor"
            assert not features.pin_protection and not features.passphrase_protection
            public_key = btc.get_public_node(session, path, coin_name="Regtest").node.public_key
            assert public_key == expected_public_key(path), "device seed differs from the deterministic fixture"
            address = btc.get_address(session, "Regtest", path, script_type=messages.InputScriptType.SPENDWITNESS)
            destination = btc.get_address(session, "Regtest", destination_path, script_type=messages.InputScriptType.SPENDWITNESS)
            assert address.startswith("bcrt1") and destination.startswith("bcrt1")
            witness_script = b"\0\x14" + hash160(public_key)
            previous = messages.TransactionType(
                version=1, lock_time=0,
                inputs=[messages.TxInputType(prev_hash=b"\0" * 32, prev_index=0xFFFFFFFF, script_sig=b"fixture", sequence=0xFFFFFFFF)],
                bin_outputs=[messages.TxOutputBinType(amount=1_000_000, script_pubkey=witness_script)],
            )
            raw_previous = (
                struct.pack("<I", 1) + b"\x01" + b"\0" * 32 + b"\xff" * 4 + b"\x07fixture" + b"\xff" * 4
                + b"\x01" + struct.pack("<Q", 1_000_000) + b"\x16" + witness_script + b"\0" * 4
            )
            previous_hash = sha256d(raw_previous)[::-1]
            signatures, serialized = btc.sign_tx(
                session, "Regtest",
                [messages.TxInputType(address_n=path, prev_hash=previous_hash, prev_index=0, amount=1_000_000, script_type=messages.InputScriptType.SPENDWITNESS, sequence=0xFFFFFFFF)],
                [messages.TxOutputType(address=destination, amount=999_000, script_type=messages.OutputScriptType.PAYTOADDRESS)],
                prev_txes={previous_hash: previous}, version=2, lock_time=0,
            )
            assert len(signatures) == 1 and signatures[0] and len(serialized) > 150
            # Independently verify the returned signature using the BIP143 digest.
            outpoint = previous_hash[::-1] + b"\0" * 4
            output = struct.pack("<Q", 999_000) + b"\x16\0\x14" + hash160(expected_public_key(destination_path))
            script_code = b"\x19\x76\xa9\x14" + hash160(public_key) + b"\x88\xac"
            digest = sha256d(
                struct.pack("<I", 2) + sha256d(outpoint) + sha256d(b"\xff" * 4) + outpoint
                + script_code + struct.pack("<Q", 1_000_000) + b"\xff" * 4 + sha256d(output)
                + struct.pack("<II", 0, 1)
            )
            verifier = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), public_key)
            verifier.verify(signatures[0], digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
            print(json.dumps({"initialized": True, "label": features.label, "deterministic_public_key": True, "regtest_address": address, "bridge_signing": "verified", "signed_bytes": len(serialized)}, sort_keys=True))
    signal.alarm(0)


if __name__ == "__main__":
    main()
