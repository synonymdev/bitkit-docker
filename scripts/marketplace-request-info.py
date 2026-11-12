#!/usr/bin/env python3
"""Read one delivered request's authenticated SDK handoff; never export keys.

Envelope/AAD/HKDF match paykit-server caf2b6d crypto.rs. Runs inside the
isolated fixture host. The fixture master key exists only in process memory.
"""
import base64
import hashlib
import hmac
import json
import re
import subprocess
import sys
import uuid


def decode_intent(plain):
    """Read caf2b6d DeliveryIntentV1's Postcard v2 Bitcoin-only layout.

    Struct field order and json_map_as_string follow application/semantic_intent.rs.
    Quoted-rate intents need their own reviewed schema; never guess past them.
    """
    class Reader:
        def __init__(self):
            self.position = 0

        def number(self, bound):
            value = 0
            for index in range(5):
                if self.position >= len(plain):
                    raise ValueError('Unsupported intent')
                byte = plain[self.position]
                self.position += 1
                value |= (byte & 127) << (7 * index)
                if byte < 128:
                    if value > bound or (index and byte == 0):
                        raise ValueError('Unsupported intent')
                    return value
            raise ValueError('Unsupported intent')

        def text(self, bound):
            length = self.number(bound)
            end = self.position + length
            if end > len(plain):
                raise ValueError('Unsupported intent')
            value = plain[self.position:end].decode('utf-8')
            self.position = end
            return value

        def optional_text(self):
            return self.text(128) if self.number(1) else None

    reader = Reader()
    version = reader.number(2)
    recipient = reader.text(2048)
    app_id = reader.text(64)
    if version != 2 or app_id != 'paykit-server' or reader.number(1) != 0:
        raise ValueError('Unsupported intent')
    terms = {'amount': reader.text(64), 'asset': reader.text(32)}
    if reader.number(64) != 0:
        raise ValueError('Unsupported intent')
    reader.text(4096)  # payment_reference stays private
    reader.optional_text()
    reader.optional_text()
    terms['accepted_endpoint_identifiers'] = [reader.text(64) for _ in range(reader.number(8))]
    endpoints = {}
    for _ in range(reader.number(8)):
        identifier, value = reader.text(64), reader.text(1024)
        if identifier in endpoints:
            raise ValueError('Unsupported intent')
        endpoints[identifier] = value
    terms['payment_endpoints'] = endpoints
    terms['metadata'] = reader.text(32768)
    if reader.position != len(plain):
        raise ValueError('Unsupported intent')
    return {'version': version, 'reader_pubky': recipient, 'app_id': app_id,
            'operation': {'PaymentRequestProposal': {'terms': terms}}}


def context(row):
    creator = bytes.fromhex(row['creator_hash'])
    if len(creator) != 32:
        raise ValueError('Invalid context')
    parts = [b'paykit-server', b'\x01', b'outbox-semantic-intent', creator,
             uuid.UUID(row['row_id']).bytes]
    return b''.join(len(p).to_bytes(4, 'big') + p for p in parts)


def project(row, encoded_key, bundle, request_id):
    from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_decrypt
    if row['request_id'] != request_id or row['status'] != 'delivered':
        raise ValueError('Request is not delivered')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', encoded_key):
        raise ValueError('Invalid fixture key')
    master = base64.urlsafe_b64decode(encoded_key + '=')
    # RFC5869 HKDF-SHA256, no salt, one32-byte block; upstream AEAD_LABEL.
    prk = hmac.digest(bytes(32), master, 'sha256')
    key = hmac.digest(prk, b'paykit-server/aead/v1\x01', 'sha256')
    envelope = bytes.fromhex(row['envelope'])
    if not 41 <= len(envelope) <= 131072 or envelope[0] != 1:
        raise ValueError('Unsupported envelope')
    plain = crypto_aead_xchacha20poly1305_ietf_decrypt(
        envelope[25:], context(row), envelope[1:25], key)
    intent = decode_intent(plain)
    if intent['version'] != 2 or intent['app_id'] != 'paykit-server':
        raise ValueError('Unsupported intent')
    terms = intent['operation']['PaymentRequestProposal']['terms']
    if json.loads(terms['metadata']).get('bundle_id') != bundle:
        raise ValueError('Request belongs to another bundle')
    identifiers = terms['accepted_endpoint_identifiers']
    asset = terms['asset']
    if (not isinstance(asset, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', asset)
            or not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 8
            or any(not isinstance(i, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', i)
                   for i in identifiers)):
        raise ValueError('Unsupported terms shape')
    endpoints = []
    for identifier in identifiers:
        raw = terms['payment_endpoints'][identifier]
        if not isinstance(raw, str) or len(raw) > 1024:
            raise ValueError('Unsupported payload size')
        try:
            value = json.loads(raw)
            safe = (isinstance(value, dict) and set(value) == {'value'}
                    and isinstance(value['value'], str)
                    and re.fullmatch(r'(?:bcrt1|bc1|tb1)[0-9a-z]{10,90}', value['value']))
        except ValueError:
            safe = False
        # Preserve negative observations without disclosing arbitrary private
        # payload text. A valid public Bitcoin address permits the exact JSON.
        endpoints.append({'identifier': identifier,
                          'value_json': raw if safe else None,
                          'value': value['value'] if safe else None,
                          'public_bitcoin_json': bool(safe),
                          'payload_sha256': hashlib.sha256(raw.encode()).hexdigest()})
    return {'source': 'authenticated_durable_sdk_handoff', 'bundle_id': bundle,
            'payment_request_id': request_id, 'delivery': row['status'],
            'asset': terms['asset'], 'amount': terms['amount'],
            'endpoints': endpoints,
            'intent_sha256': hashlib.sha256(plain).hexdigest()}


def observe(bundle, request_id, run=subprocess.run):
    if (not re.fullmatch(r'[0-9A-HJKMNP-TV-Z]{26}', bundle) or
            str(uuid.UUID(request_id)) != request_id):
        raise ValueError('Use the exact bundle and native request UUID')
    compose = ['docker', 'compose', '--profile', 'marketplace', 'exec', '-T']
    # UUID validation leaves no SQL syntax under caller control. No mutation,
    # session import, resync, enqueue or payment is performed.
    query = """BEGIN READ ONLY;
SELECT json_build_object('row_id',o.id,
 'creator_hash',encode(c.creator_lookup_hash,'hex'),
 'envelope',encode(o.intent_envelope,'hex'),
 'request_id',o.sdk_payment_request_id,'status',o.status)
FROM outbox o JOIN creators c ON c.id=o.creator_id
WHERE o.sdk_payment_request_id='%s'
 AND o.intent_kind='payment_request_proposal'; COMMIT;""" % request_id
    rows = run(compose + ['marketplace-postgres', 'psql', '-X', '-qAt',
                         '-v', 'ON_ERROR_STOP=1', '-U', 'marketplace', '-d',
                         'paykit', '-c', query], capture_output=True, text=True,
               check=True, timeout=20).stdout.splitlines()
    if len(rows) != 1 or len(rows[0]) > 300000:
        raise ValueError('Request is missing or ambiguous')
    secret = run(compose + ['paykit-server', 'cat', '/state/paykit/master-key'],
                 capture_output=True, text=True, check=True, timeout=20).stdout.strip()
    return project(json.loads(rows[0]), secret, bundle, request_id)


def main(argv):
    try:
        if len(argv) != 2:
            raise ValueError('Use bundle and request id')
        print(json.dumps(observe(*argv)))
        return 0
    except Exception:
        # Subprocess output/decrypted fields may be private. No repr/traceback.
        print('Request observation unavailable; requires a delivered matching '
              'native request, semantic-outbox server and Python PyNaCl.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
