#!/usr/bin/env python3
"""Fetch an exact-source CI AAR without building or changing an app checkout."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import struct
import tempfile
import zipfile

REPO = 'synonymdev/bitkit-core'
ARTIFACT = 'bitkit-core-android-bindgen'

def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)

def validate_aar(path):
    with zipfile.ZipFile(path) as aar:
        for abi, machine in {'arm64-v8a': 183, 'armeabi-v7a': 40, 'x86': 3, 'x86_64': 62}.items():
            native = aar.read(f'jni/{abi}/libbitkitcore.so')
            if len(native) < 64 or not native.startswith(b'\x7fELF') or native[5] != 1 or struct.unpack_from('<H', native, 18)[0] != machine:
                raise ValueError(f'{abi}: invalid native library or wrong architecture')
            if b'send_with_deadline' not in native:
                raise ValueError(f'{abi}: native library lacks the deadline API')
        with zipfile.ZipFile(io.BytesIO(aar.read('classes.jar'))) as classes:
            wallets = [name for name in classes.namelist() if name.endswith('/UsdtWallet.class')]
            if len(wallets) != 1 or b'sendWithDeadline' not in classes.read(wallets[0]):
                raise ValueError('AAR lacks UsdtWallet.sendWithDeadline; refusing the old core package')
    return hashlib.sha256(path.read_bytes()).hexdigest()

def fetch(commit, out):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('--commit must be a full git SHA')
    runs = json.loads(gh('api', f'repos/{REPO}/actions/runs?head_sha={commit}&per_page=100'))['workflow_runs']
    runs = [r for r in runs if r['head_sha'] == commit and r['name'] == 'Android Bindgen' and r['conclusion'] == 'success']
    if not runs:
        raise ValueError(f'no successful Android Bindgen artifact for {commit}; wait for CI, never fall back to a release')
    run = max(runs, key=lambda r: r['id'])
    artifacts = json.loads(gh('api', f"repos/{REPO}/actions/runs/{run['id']}/artifacts"))['artifacts']
    matches = [a for a in artifacts if a['name'] == ARTIFACT and not a['expired']]
    if len(matches) != 1:
        raise ValueError('exact-source Android artifact unavailable or expired')
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='download-', dir=out) as tmp:
        gh('run', 'download', str(run['id']), '--repo', REPO, '--name', ARTIFACT, '--dir', tmp)
        aars = list(Path(tmp).rglob('*release.aar'))
        if len(aars) != 1:
            raise ValueError('expected exactly one release AAR in generated artifacts')
        digest = validate_aar(aars[0])
        destination = out / f'bitkit-core-{commit}.aar'
        destination.write_bytes(aars[0].read_bytes())
    manifest = {'repo': REPO, 'commit': commit, 'run': run['id'], 'artifact': matches[0]['id'], 'aar': str(destination.resolve()), 'sha256': digest, 'deadline_api': 'sendWithDeadline'}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(fetch(args.commit, args.out)))
    except (ValueError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        parser.exit(1, f'{error}\n')
