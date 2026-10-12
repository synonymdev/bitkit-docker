#!/usr/bin/env python3
"""Check disposable fixture controls, without a Bitkit app or a device."""
import argparse
import json
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

PIN = '03d4f05721e92d3944cb4d5af4b2c98c4390a5a8'


def call(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def link(issuer, peer, to_peer, to_issuer):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        call(issuer, '/link', to_peer)
        call(peer, '/link', to_issuer)
        a = call(issuer, '/sync', to_peer)
        b = call(peer, '/sync', to_issuer)
        if a.get('link') == b.get('link') == 'linked':
            return
        time.sleep(.2)
    raise RuntimeError('two disposable peers did not finish a link within 60 seconds')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--issuer', default='http://127.0.0.1:23012')
    parser.add_argument('--peer', default='http://127.0.0.1:23013')
    parser.add_argument('--monthly', action='store_true')
    args = parser.parse_args()
    a, b = call(args.issuer, '/health'), call(args.peer, '/health')
    assert a['paykit_rs_rev'] == b['paykit_rs_rev'] == PIN
    to_peer = {'peer_pubky': b['pubky'], 'peer_path': b['receiver_path']}
    to_issuer = {'peer_pubky': a['pubky'], 'peer_path': a['receiver_path']}
    link(args.issuer, args.peer, to_peer, to_issuer)
    request_id = str(uuid.uuid4())
    request = dict(to_peer, payment_request_id=request_id, amount_sats=15000,
                   reference='fixture-proposal-identity', no_deadline=True)
    if args.monthly:
        request['monthly_starts_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    call(args.issuer, '/request', request)
    call(args.peer, '/sync', to_issuer)
    # Persist delivery confirmation before dropping the link, so the old event is not resent.
    call(args.issuer, '/sync', to_peer)
    def record():
        rows = call(args.peer, '/records', to_issuer)['records']
        return next(row for row in rows if row['payment_request_id'] == request_id)
    old = record()
    assert old['state'] == 'Proposed' and old['proposal_stream_item_id'] is not None
    call(args.peer, '/forget', to_issuer)
    call(args.issuer, '/reset-link', to_peer)
    link(args.issuer, args.peer, to_peer, to_issuer)
    replaced = call(args.issuer, '/replace', dict(to_peer, payment_request_id=request_id))
    assert replaced['original_event_id'] != replaced['replacement_event_id']
    call(args.peer, '/sync', to_issuer)
    new = record()
    assert new['state'] == 'Proposed', new
    assert old['terms'] == new['terms']
    assert old['proposal_stream_item_id'] != new['proposal_stream_item_id']
    try:
        call(args.peer, '/accept', dict(to_issuer, payment_request_id=request_id,
                                     expected_proposal_stream_item_id=old['proposal_stream_item_id']))
    except urllib.error.HTTPError as error:
        detail = json.load(error)
        assert error.code == 400 and 'expected stream item' in detail['error'], detail
    else:
        raise AssertionError('fixture accepted an obsolete stream item ID')
    accepted = call(args.peer, '/accept', dict(to_issuer, payment_request_id=request_id,
                                            expected_proposal_stream_item_id=new['proposal_stream_item_id']))
    assert accepted['state'] == ('ActiveRecurring' if args.monthly else 'Accepted'), accepted
    print(json.dumps({'fixture': 'ready', 'recurring': args.monthly,
                      'same_request_id': request_id, 'same_terms': True,
                      'old_stream_id': old['proposal_stream_item_id'],
                      'new_stream_id': new['proposal_stream_item_id'],
                      'obsolete_acceptance': 'refused', 'current_acceptance': accepted['state']}))


if __name__ == '__main__':
    main()
