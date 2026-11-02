"""Execute the real build RUN's fetch/selection boundary with an empty Cargo cache.

Cargo is a controlled dependency downloader/compiler stub here; actual Rust and
Docker builds remain a separate native acceptance requirement.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ColdCargoBuild(unittest.TestCase):
    def test_default_legacy_and_pinned_stable_fetch_inside_the_selected_cache(self):
        lines = (ROOT / 'payment-requests/Dockerfile').read_text().splitlines(keepends=True)
        start = next(i for i, line in enumerate(lines) if line.startswith('RUN --mount=type=cache'))
        block = [lines[start]]
        while block[-1].rstrip().endswith('\\'):
            block.append(lines[start + len(block)])
        # Match the classic transport only; preserve the actual shell statements.
        command = ''.join(line for line in block if '--mount=' not in line).lstrip()
        for stable in (False, True):
            with self.subTest(stable=stable), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); binaries = root / 'bin'; binaries.mkdir(); (root / 'out').mkdir()
                revision = ('b' if stable else 'a') * 40
                (root / 'Cargo.lock').write_text('[[package]]\nname = "paykit-sdk"\nversion = "0.1.0"\nsource = "git+https://github.com/pubky/paykit-rs.git?rev=' + revision + '#' + revision + '"\n')
                shutil.copyfile(ROOT / 'payment-requests/select-sdk-features.sh', root / 'select-sdk-features.sh')
                extra = 'expected_proposal_stream_item_id: u64,\n' if stable else ''
                signature = 'pub async fn accept_payment_request(\n&self,\ncounterparty: PubkyPublicKey,\npayment_request_id: &PaymentRequestId,\n' + extra + ') -> Result<PaymentRequestRecord> {\n}\n'
                (binaries / 'cargo').write_text('''#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
args=sys.argv[1:]
with open(os.environ['QA_TEST_EVENTS'],'a') as output:output.write(json.dumps(args)+'\\n')
source=Path(os.environ['CARGO_HOME'])/'git/checkouts/paykit-rs-test'/os.environ['QA_TEST_REV'][:7]/'paykit-sdk/src/runtime/payment_requests.rs'
if args==['fetch','--locked']:
 source.parent.mkdir(parents=True,exist_ok=True);source.write_text(os.environ['QA_TEST_SIGNATURE'])
elif args[0]=='build':
 assert source.is_file(), 'Compiler reached before dependency fetch'
 assert ('--features=versioned-payment-request-acceptance' in args)==('expected_proposal_stream_item_id' in source.read_text())
else:raise SystemExit('Unexpected Cargo operation')
''')
                (binaries / 'install').write_text('#!/bin/sh\nexit 0\n')
                for path in binaries.iterdir(): path.chmod(0o755)
                environment = {**os.environ, 'PATH':str(binaries)+os.pathsep+os.environ['PATH'], 'CARGO_HOME':str(root/'empty-cargo-cache'), 'QA_TEST_REV':revision, 'QA_TEST_SIGNATURE':signature, 'QA_TEST_EVENTS':str(root/'events.jsonl')}
                result = subprocess.run(['sh','-eu','-c',command.replace('/out/',str(root/'out')+'/')],cwd=root,env=environment,text=True,capture_output=True)
                self.assertEqual(result.returncode,0,result.stderr)
                events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
                self.assertEqual(events[0],['fetch','--locked'])
                self.assertEqual(events[1][:3],['build','--release','--locked'])
                self.assertEqual((root/'out/paykit-rs-rev').read_text().strip(),revision)


if __name__ == '__main__':
    unittest.main()
