#!/usr/bin/env python3
"""Create the Lock of a digital Shop listing on the profile's Lock Server, as the seller (./shop-order lock).

The Shop's studio cannot author a digital Lock, so this does what the Shop repository's live proof does
(src/test/live/locks-payment.live.ts): register the guarded content with the seller's Locks session, create a content Lock whose
one criterion is a Paykit payment of the listing's price to the seller, and print the `digitalLock` the listing must carry. It
writes no order and no payment. The seller's Locks session is the frontend session the Shop holds after "Connect Locks" (a file
with {"session_token": ..., "creator": ...}); it stays private and is only sent to the Lock Server.

`resourceHash` is the guarded content's BLAKE3 (the top 256 bits of the Lock Server's Crockford hash). It is not the listing's
cover `contentHash` that the service registers: keep the two apart.
"""
import argparse
import json
import pathlib
import sys
import urllib.error
import urllib.request

CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


def call(base, method, path, token, body=None, ctype='application/json'):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    request = urllib.request.Request(base + path, data, {'Content-Type': ctype, 'Authorization': f'Bearer {token}'}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b'null')
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors='replace')


def resource_hash(crockford):
    value = 0
    for char in crockford:
        value = value * 32 + CROCKFORD.index(char)
    return (value >> (len(crockford) * 5 - 256)).to_bytes(32, 'big').hex()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--locks-url', required=True, help='the Lock Server URL (./shop-order urls)')
    parser.add_argument('--session-file', required=True, type=pathlib.Path, help='the seller Locks session JSON (private)')
    parser.add_argument('--content', required=True, type=pathlib.Path, help='the file the buyer unlocks')
    parser.add_argument('--sats', required=True, type=int, help='the listing price in sats')
    parser.add_argument('--criterion', default='shop-order-payment')
    parser.add_argument('--lock-server', help='pubky<key> of the Lock Server that verifies the Lock (./shop-order passes the profile\'s own)')
    parser.add_argument('--out', type=pathlib.Path, default=pathlib.Path('.shop-order/evidence'))
    args = parser.parse_args()

    session = json.loads(args.session_file.read_text())
    token, seller = session['session_token'], session['creator'].removeprefix('pubky')
    base = args.locks_url.rstrip('/')

    status, ready = call(base, 'GET', '/creator/paykit/setup-status', token)
    if status != 200 or not isinstance(ready, dict) or ready.get('status') != 'ready':
        sys.exit(f'the seller is not ready on the Lock Server ({status}): connect Locks, reload, then do the Paykit setup')
    status, registered = call(base, 'PUT', f'/creator/priv-resources/content/{args.content.name}', token,
                              args.content.read_bytes(), 'text/plain')
    if status != 200:
        sys.exit(f'registering the content failed ({status}): {registered}')
    guarded = registered['guarded_resource']
    lock_server = args.lock_server
    request = {
        'primary_resource': guarded,
        'secondary_resources': {},
        'criteria': [{'criterion_id': args.criterion, 'verifier_type': 'paykit-payment',
                      'params': {'recipient_pubky': f'pubky{seller}', 'amount': str(args.sats), 'asset': 'BTC'}}],
        'lock_logic': {'type': 'all', 'criteria': [args.criterion]},
        'access_policy': {'requested_credential_ttl_seconds': 3600},
    }
    if lock_server:
        request['lock_server'] = {'override': lock_server}
    status, created = call(base, 'POST', '/creator/content-locks', token, request)
    if status != 200:
        sys.exit(f'creating the Lock failed ({status}): {created}')
    digital_lock = {
        'policyUri': f"pubky://{seller}{created['content_lock_path']}",
        'criterionId': args.criterion,
        'contentPath': args.content.name,
        'resourceHash': resource_hash(guarded['hash']),
        'minimumConfirmations': 1,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"lock-{created['lock_id']}.json").write_text(json.dumps({'request': request, 'lock_id': created['lock_id'],
                                                                           'digitalLock': digital_lock}, indent=2))
    print(json.dumps(digital_lock, indent=2))


if __name__ == '__main__':
    main()
