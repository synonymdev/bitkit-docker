import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTION = re.search(r'^apply_paykit_server_patches\(\) \{\n.*?^\}\n', (ROOT / 'pubky-marketplace').read_text(), re.M | re.S)[0]
PATCH = """--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
+new
"""


class RevisionScopedPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tree = self.root / '.marketplace/sources/paykit-server'
        self.tree.mkdir(parents=True)
        (self.root / 'marketplace/patches').mkdir(parents=True)

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.tree), *args], check=True, capture_output=True)

    def checkout(self, content):
        (self.tree / 'file.txt').write_text(content)
        self.git('init', '-q')
        self.git('add', 'file.txt')
        self.git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'tree')

    def run_patches(self, header, revision):
        (self.root / 'marketplace/patches/paykit-server-example.patch').write_text(header + '\n' + PATCH)
        script = f'SOURCES=.marketplace/sources\nPAYKIT_SERVER_REV={revision}\n{FUNCTION}apply_paykit_server_patches\n'
        return subprocess.run(['bash', '-c', script], cwd=self.root, capture_output=True, text=True)

    def test_scoped_patch_is_skipped_on_another_revision(self):
        self.checkout('other\n')
        result = self.run_patches('Applies-to: ' + 'a' * 40, 'b' * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('applies only to paykit-server aaaaaaaa', result.stdout)
        self.assertEqual((self.tree / 'file.txt').read_text(), 'other\n')

    def test_scoped_patch_applies_on_its_revision(self):
        self.checkout('old\n')
        result = self.run_patches('Applies-to: ' + 'a' * 40, 'a' * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.tree / 'file.txt').read_text(), 'new\n')

    def test_scoped_patch_that_does_not_apply_on_its_revision_stops(self):
        self.checkout('other\n')
        result = self.run_patches('Applies-to: ' + 'a' * 40, 'a' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not apply', result.stderr)

    def test_unscoped_patch_that_does_not_apply_still_stops(self):
        self.checkout('other\n')
        result = self.run_patches('Upstream: none', 'b' * 40)
        self.assertNotEqual(result.returncode, 0)

    def test_shipped_rc8_patch_is_scoped_to_its_base(self):
        text = (ROOT / 'marketplace/patches/paykit-server-paykit-rs-rc8.patch').read_text()
        pins = (ROOT / 'pubky-marketplace').read_text()
        scoped = re.search(r'^Applies-to: ([0-9a-f]{40})$', text, re.M)[1]
        self.assertIn(f'PAYKIT_SERVER_REV=${{PAYKIT_SERVER_REV:-{scoped}}}', pins)


if __name__ == '__main__':
    unittest.main()
