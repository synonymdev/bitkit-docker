#!/usr/bin/env python3
"""Wait for live, explicitly held requests on the homeserver proxy."""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def normalize(owner):
    owner = owner.strip()
    return owner[5:] if owner.startswith('pubky') and len(owner) == 57 else owner


def matches(snapshot, owner, path, methods, count):
    pending = [request for request in snapshot.get('pending', [])
               if request['owner'] == normalize(owner) and request['path'].startswith(path)]
    return (all(sum(request['method'] == method for request in pending) >= count
                for method in methods) if methods else len(pending) >= count)


def wait(url, owner, path, methods, count, timeout):
    deadline = time.monotonic() + timeout
    snapshot = {}
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(json.dumps({'error': 'required requests are not held',
                                           'snapshot': snapshot}))
        with urllib.request.urlopen(url.rstrip('/') + '/requests', timeout=min(5, remaining)) as response:
            snapshot = json.load(response)
        # Fail on the old API rather than accepting completed requests as an arrival gate.
        if 'pending' not in snapshot:
            raise ValueError('proxy has no pending snapshot; install the explicit-hold build')
        if matches(snapshot, owner, path, methods, count):
            return snapshot
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', default='http://127.0.0.1:23298')
    parser.add_argument('--owner', required=True)
    parser.add_argument('--path', default='')
    parser.add_argument('--method', action='append', default=[], help='repeat to require simultaneous methods')
    parser.add_argument('--count', type=int, default=1, help='minimum live requests per method')
    parser.add_argument('--timeout', type=float, default=30)
    args = parser.parse_args()
    if args.count < 1 or args.timeout <= 0:
        parser.error('count and timeout must be positive')
    try:
        print(json.dumps(wait(args.control, args.owner, args.path,
                              [method.upper() for method in args.method], args.count, args.timeout)))
    except (TimeoutError, ValueError, OSError, urllib.error.URLError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
