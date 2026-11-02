import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('paykit_classic', Path(__file__).with_name('paykit-classic-dockerfile.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class ClassicBuilderTests(unittest.TestCase):
    def source(self, locks=False):
        text = '# syntax=docker/dockerfile:1.7\nFROM rust:fixed AS builder\n'
        text += 'RUN --mount=from=paykit-lib,target=/contexts/paykit-lib,ro \\\n    --mount=from=paykit-sdk,target=/contexts/paykit-sdk,ro \\\n'
        if locks:
            text += '    --mount=from=locks,target=/contexts/locks,ro \\\n'
        text += '    set -eu; \\\n    cp -a /contexts/paykit-lib /build/paykit-rs/paykit-lib; \\\n    cp -a /contexts/paykit-sdk /build/paykit-rs/paykit-sdk\n'
        text += 'COPY . /build/paykit-server\nRUN --mount=type=cache,target=/cache \\\n    --mount=type=cache,target=/target \\\n    cargo build --locked --release\nFROM runtime:fixed\nCOPY --from=builder /out/server /usr/local/bin/server\n'
        return text

    def test_both_legacy_and_registry_release_build_contexts_are_preserved(self):
        for locks in (False, True):
            with self.subTest(locks=locks):
                result = helper.transform(self.source(locks), 'a'*40, 'b'*40, 'fix.patch')
                self.assertIn('COPY paykit-server /build/paykit-server', result)
                self.assertIn('COPY paykit-rs/paykit-sdk /contexts/paykit-sdk', result)
                self.assertIn('cp -a /contexts/paykit-sdk /build/paykit-rs/paykit-sdk', result)
                self.assertEqual('COPY locks /contexts/locks' in result, locks)
                self.assertIn('cargo build --locked --release', result)
                self.assertIn('COPY --from=builder /out/server /usr/local/bin/server', result)
                self.assertIn('tech.masivo.paykit-server="' + 'a'*40 + '"', result)
                self.assertNotIn('--mount', result)
                self.assertNotIn('# syntax=', result)

    def test_upstream_required_source_commands_are_never_discarded(self):
        for locks in (False, True):
            source = self.source(locks).replace('    set -eu;', '    test -f /contexts/paykit-lib/REQUIRED_SOURCE_SENTINEL; \\\n    set -eu;')
            result = helper.transform(source, 'a'*40, 'b'*40, '')
            self.assertIn('test -f /contexts/paykit-lib/REQUIRED_SOURCE_SENTINEL;', result)
            self.assertIn('set -eu;', result)

    def test_rejects_unsupported_or_missing_build_contexts_instead_of_guessing(self):
        sources = [self.source().replace('COPY . /build/paykit-server', 'COPY . /other'),
                   self.source().replace('--mount=from=paykit-sdk', '--mount=from=unknown'),
                   self.source() + 'RUN --mount=from=other echo no\n']
        for source in sources:
            with self.subTest(source=source), self.assertRaises(ValueError):
                helper.transform(source, 'a'*40, 'b'*40, '')


if __name__ == '__main__':
    unittest.main()
