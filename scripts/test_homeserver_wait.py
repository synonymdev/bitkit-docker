import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('homeserver_wait', Path(__file__).with_name('homeserver-wait.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WaitTests(unittest.TestCase):
    def test_overlap_requires_both_methods_on_the_same_owner_and_path(self):
        owner = 'y' * 52
        pending = [{'owner': owner, 'path': '/pub/paykit/key', 'method': 'DELETE'}]
        snapshot = {'pending': pending, 'requests': [{'owner': owner, 'method': 'PUT'}]}
        self.assertFalse(module.matches(snapshot, owner, '/pub/paykit', ['DELETE', 'PUT'], 1))
        pending.append({'owner': 'z' * 52, 'path': '/pub/paykit/key', 'method': 'PUT'})
        self.assertFalse(module.matches(snapshot, owner, '/pub/paykit', ['DELETE', 'PUT'], 1))
        pending.append({'owner': owner, 'path': '/other', 'method': 'PUT'})
        self.assertFalse(module.matches(snapshot, owner, '/pub/paykit', ['DELETE', 'PUT'], 1))
        pending.append({'owner': owner, 'path': '/pub/paykit/key', 'method': 'PUT'})
        self.assertTrue(module.matches(snapshot, 'pubky' + owner, '/pub/paykit', ['DELETE', 'PUT'], 1))

    def test_timeout_is_failure_and_does_not_release_rules(self):
        with patch.object(module.time, 'monotonic', side_effect=[0, 1]):
            with self.assertRaisesRegex(TimeoutError, 'not held'):
                module.wait('http://unused', 'y' * 52, '', [], 1, 0.5)


if __name__ == '__main__':
    unittest.main()
