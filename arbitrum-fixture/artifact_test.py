import importlib.util
import io
from pathlib import Path
import tempfile
import struct
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('artifact', Path(__file__).parent.parent / 'scripts/fetch-bitkit-core-android.py')
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)

class ArtifactValidation(unittest.TestCase):
    def aar(self, path, deadline=True, abis=('arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64')):
        jar = io.BytesIO()
        with zipfile.ZipFile(jar, 'w') as classes:
            classes.writestr('com/synonym/bitkitcore/UsdtWallet.class', b'CAFEBABE sendWithDeadline' if deadline else b'CAFEBABE send')
        with zipfile.ZipFile(path, 'w') as aar:
            aar.writestr('classes.jar', jar.getvalue())
            for abi in abis:
                native = bytearray(64); native[:4] = b'\x7fELF'; native[5] = 1
                struct.pack_into('<H', native, 18, {'arm64-v8a': 183, 'armeabi-v7a': 40, 'x86': 3, 'x86_64': 62}[abi])
                aar.writestr(f'jni/{abi}/libbitkitcore.so', bytes(native) + b'send_with_deadline')

    def test_matching_bindings_and_four_abis(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'core.aar'; self.aar(path)
            self.assertEqual(len(artifact.validate_aar(path)), 64)

    def test_old_api_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'core.aar'; self.aar(path, deadline=False)
            with self.assertRaisesRegex(ValueError, 'old core'):
                artifact.validate_aar(path)

    def test_missing_native_abi_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'core.aar'; self.aar(path, abis=('arm64-v8a',))
            with self.assertRaises(KeyError):
                artifact.validate_aar(path)

    def test_no_successful_head_never_falls_back(self):
        original = artifact.gh
        artifact.gh = lambda *args: '{"workflow_runs": []}'
        try:
            with self.assertRaisesRegex(ValueError, 'never fall back'):
                artifact.fetch('0' * 40, Path('/unused'))
        finally:
            artifact.gh = original

if __name__ == '__main__': unittest.main()
