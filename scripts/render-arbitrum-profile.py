#!/usr/bin/env python3
"""Render only the Arbitrum profile for an existing seat project, with remapped ports."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port-offset', type=int, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
if args.port_offset not in range(0, 8001, 1000):
    parser.error('port offset must be a seat block: 0, 1000, ..., 8000')
root = Path(__file__).resolve().parent.parent
config = json.loads(subprocess.check_output([
    'docker', 'compose', '--env-file', '/dev/null', '-f', str(root / 'docker-compose.yml'),
    '--profile', 'arbitrum', 'config', '--format', 'json',
], text=True))
services = {name: config['services'][name] for name in ('arbitrum-chain', 'arbitrum-provider')}
for service in services.values():
    for port in service.get('ports', []):
        port['published'] = str(int(port['published']) + args.port_offset)
profile = {'services': services, 'volumes': {'arbitrum_fixture_data': {}}, 'networks': {'default': {}}}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(profile, indent=2) + '\n')
print(json.dumps({'compose_file': str(args.out.resolve()), 'chain_port': 23545 + args.port_offset, 'provider_port': 23546 + args.port_offset}))
