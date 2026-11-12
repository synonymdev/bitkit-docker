import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SavedFixturePinsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / '.marketplace').mkdir()
        (self.root / 'marketplace/patches').mkdir(parents=True)
        (self.root / 'marketplace/patches/paykit-server-example.patch').write_text('example')
        shutil.copyfile(ROOT / 'pubky-marketplace', self.root / 'pubky-marketplace')
        shutil.copyfile(ROOT / 'scripts/paykit-lock.py', self.root / 'scripts/paykit-lock.py')
        shutil.copyfile(ROOT / 'scripts/marketplace-policy.py', self.root / 'scripts/marketplace-policy.py')
        shutil.copyfile(ROOT / 'scripts/marketplace-driver-source.py', self.root / 'scripts/marketplace-driver-source.py')
        shutil.copytree(ROOT / 'marketplace/driver', self.root / 'marketplace/driver', ignore=shutil.ignore_patterns('node_modules', '.Dockerfile*'))
        self.pins = {'serverRevision': 'a'*40, 'paykitRevision': 'b'*40, 'paykitTag': 'v0.1.0', 'locksRevision': 'c'*40, 'locksTag': 'v0.1.0'}

    def command(self, overrides=None, command='pins'):
        (self.root / '.marketplace/paykit-pins.json').write_text(json.dumps(self.pins))
        env = {'PATH': os.environ['PATH'], 'HOME': str(self.root), **(overrides or {})}
        return subprocess.run(['bash', str(self.root / 'pubky-marketplace'), command], cwd=self.root, env=env, capture_output=True, text=True)

    def test_full_rebuild_keeps_aligned_fixture_and_refuses_wrong_built_revision(self):
        for name in ('paykit-server', 'paykit-rs', 'locks'):
            (self.root / '.marketplace/sources' / name / '.git').mkdir(parents=True)
        lock = '\n'.join(f'[[package]]\nname = "{name}"\nversion = "0.1.0"\nsource = "git+https://github.com/pubky/{repo}.git?tag=v0.1.0#{revision}"\n' for name, repo, revision in [('paykit-lib', 'paykit-rs', 'b'*40), ('paykit-sdk', 'paykit-rs', 'b'*40), ('locks-core', 'locks', 'c'*40)])
        (self.root / '.marketplace/sources/paykit-server/Cargo.lock').write_text(lock)
        policy = self.root / '.marketplace/sources/locks/locks-core/src/lock_policy.rs'
        policy.parent.mkdir(parents=True)
        policy.write_text('fn validate_paykit_payment_params(\nparams: &Value,\n) -> Result<(), Error> { if !matches!(key.as_str(), "recipient_pubky" | "amount" | "asset") { return Err(error); } }')
        binaries = self.root / 'bin'; binaries.mkdir()
        (binaries / 'git').write_text('#!/usr/bin/env python3\nimport sys\nif "rev-parse" in sys.argv:\n print(("a" if "paykit-server" in sys.argv[2] else "b" if "paykit-rs" in sys.argv[2] else "c")*40)\n')
        (binaries / 'docker').write_text('#!/usr/bin/env python3\nimport os,sys,json\nwith open(os.environ["EVENTS"],"a") as out:out.write(json.dumps(sys.argv[1:])+"\\n")\nif sys.argv[1]=="run": print(os.environ.get("OBSERVED_REV",os.environ["PAYKIT_RS_REV"]))\n')
        for path in binaries.iterdir(): path.chmod(0o755)
        events = self.root / 'events.jsonl'
        environment = {'PATH':str(binaries)+os.pathsep+os.environ['PATH'], 'EVENTS':str(events)}
        result = self.command(environment, 'build')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in events.read_text().splitlines()]
        self.assertFalse(any(call[-2:]==['build','homeserver-proxy'] for call in calls))
        self.assertIn(['run','--rm','--entrypoint','cat','bitkit-docker/payment-request-fixture:0.1.0-shared','/usr/local/share/paykit-rs-rev'], calls)
        result = self.command({**environment, 'OBSERVED_REV':'d'*40}, 'build')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Built fixture does not match', result.stderr)

    def test_all_actual_compose_peer_consumers_select_the_same_revision_and_image(self):
        import re
        compose = (ROOT / 'docker-compose.yml').read_text()
        for service in ('homeserver-proxy','fixture-issuer','rc56-peer'):
            block = re.search(r'^  '+service+r':\n(.*?)(?=^  [\w-]+:|\Z)', compose, re.M|re.S)[1]
            self.assertIn('image: bitkit-docker/payment-request-fixture:${PAYKIT_FIXTURE_TAG:-rc65-shared}', block)
            self.assertIn('PAYKIT_RS_REV: ${PAYKIT_RS_REV:-7185ae7da9315028e5331442d71d739c27f1442c}', block)

    def test_later_commands_retain_verified_stable_and_prerelease_pins(self):
        for tag, image_tag in [('v0.1.0', '0.1.0-shared'), ('v0.1.0-rc65', 'rc65-shared')]:
            with self.subTest(tag=tag):
                self.pins['paykitTag'] = tag
                result = self.command()
                self.assertEqual(result.returncode, 0, result.stderr)
                observed = json.loads(result.stdout)
                self.assertEqual(observed['serverRevision'], self.pins['serverRevision'])
                self.assertEqual(observed['paykitRevision'], self.pins['paykitRevision'])
                self.assertEqual(observed['fixtureTag'], image_tag)

    def test_explicit_operator_overrides_win_without_using_a_stale_image_tag(self):
        result = self.command({'PAYKIT_RS_REV': 'd'*40, 'PAYKIT_RS_TAG': 'v0.2.0'})
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['paykitRevision'], 'd'*40)
        self.assertEqual(observed['fixtureTag'], '0.2.0-shared')

    def test_malformed_saved_pins_stop_before_any_fixture_command(self):
        for bad in ['v0.1.0; touch should-not-exist', 123, '$(touch should-not-exist)']:
            with self.subTest(bad=bad):
                self.pins['paykitTag'] = bad
                result = self.command()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / 'should-not-exist').exists())
                self.assertNotIn('serverRevision', result.stdout)


if __name__ == '__main__':
    unittest.main()
