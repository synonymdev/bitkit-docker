import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("marketplace_auth", Path(__file__).with_name("marketplace-auth.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Docker:
    def __init__(self):
        self.containers = {}
        self.logs = {}
        self.errors = {}
        self.starts = 0
        self.lose_response = False
        self.image = "sha256:original"

    def __call__(self, argv, **kwargs):
        args = argv[1:]
        output, error, code = "", "", 0
        if args[:2] == ["image", "inspect"]:
            output = json.dumps([{"Id": self.image}])
        elif args[:2] == ["container", "inspect"]:
            if args[2] in self.containers:
                output = json.dumps([self.containers[args[2]]])
            else:
                error, code = "Error: No such container", 1
        elif args[0] == "compose":
            self.starts += 1
            name = args[args.index("--name") + 1]
            labels = {"com.docker.compose.project": "qa-fixture"}
            for index, value in enumerate(args):
                if value == "--label":
                    key, value = args[index + 1].split("=", 1)
                    labels[key] = value
            self.containers[name] = {"Config": {"Labels": labels}, "Image": self.image,
                                     "State": {"Running": True, "ExitCode": 0}}
            self.logs[name] = '{"status":"awaiting_approval","auth_url":"pubkyauth://fixture"}'
            if self.lose_response:
                raise TimeoutError("Response lost after Docker created the listener")
            output = "container-id"
        elif args[0] == "logs":
            output = self.logs[args[-1]]
            error = self.errors.get(args[-1], "")
        elif args[:2] == ["rm", "-f"]:
            del self.containers[args[2]]
        else:
            raise AssertionError(args)
        return type("Result", (), {"stdout": output, "stderr": error, "returncode": code})()


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.docker = Docker()
        self.manager = module.AuthOperations(self.temp.name, "qa-fixture", "driver:pin", self.docker)

    def test_listener_returns_url_then_approval_without_relaunch(self):
        first = self.manager.start("seller", ["--timeout", "300"])
        self.assertEqual(first["status"], "awaiting_approval")
        self.assertEqual(first["auth_url"], "pubkyauth://fixture")
        name = next(iter(self.docker.containers))
        self.docker.logs[name] += '\n{"status":"approved","seller":"pubky-test"}'
        self.docker.containers[name]["State"]["Running"] = False
        self.assertEqual(self.manager.status("seller")["status"], "approved")
        self.assertEqual(self.manager.start("seller", ["--timeout", "300"])["status"], "approved")
        self.assertEqual(self.docker.starts, 1)

    def test_lost_start_response_is_recovered_by_identity(self):
        self.docker.lose_response = True
        with self.assertRaises(TimeoutError):
            self.manager.start("seller", [])
        self.assertEqual(self.manager.status("seller")["status"], "awaiting_approval")
        self.assertEqual(self.manager.start("seller", [])["status"], "awaiting_approval")
        self.assertEqual(self.docker.starts, 1)

    def test_intent_without_container_is_uncertain_and_never_replayed(self):
        self.manager.start("seller", [])
        self.docker.containers.clear()
        self.assertEqual(self.manager.status("seller")["status"], "uncertain")
        self.assertEqual(self.manager.start("seller", [])["status"], "uncertain")
        self.assertEqual(self.docker.starts, 1)

    def test_changed_arguments_or_image_cannot_reuse_operation(self):
        self.manager.start("seller", [])
        with self.assertRaises(ValueError):
            self.manager.start("seller", ["--timeout", "900"])
        self.docker.image = "sha256:changed"
        with self.assertRaises(ValueError):
            self.manager.start("seller", [])
        self.assertEqual(self.manager.status("seller")["status"], "awaiting_approval")

    def test_wrong_owner_or_image_is_not_adopted_or_removed(self):
        self.manager.start("seller", [])
        name = next(iter(self.docker.containers))
        for field in ("owner", "image", "project"):
            original = json.loads(json.dumps(self.docker.containers[name]))
            if field == "image":
                self.docker.containers[name]["Image"] = "sha256:other"
            else:
                key = module.LABEL + ".owner" if field == "owner" else "com.docker.compose.project"
                self.docker.containers[name]["Config"]["Labels"][key] = "other"
            with self.assertRaises(RuntimeError):
                self.manager.cleanup()
            self.assertIn(name, self.docker.containers)
            self.docker.containers[name] = original

    def test_failed_listener_does_not_echo_auth_url_or_restart(self):
        self.manager.start("seller", [])
        container = next(iter(self.docker.containers.values()))
        container["State"] = {"Running": False, "ExitCode": 1}
        result = self.manager.start("seller", [])
        self.assertEqual(result, {"operation": "seller", "status": "failed", "exitCode": 1,
                                  "reason": "grant-listener-failed"})
        self.assertEqual(self.docker.starts, 1)

    def test_stderr_failure_has_a_safe_actionable_reason_without_private_log_text(self):
        self.manager.start("seller", [])
        name = next(iter(self.docker.containers))
        self.docker.containers[name]["State"] = {"Running": False, "ExitCode": 1}
        self.docker.errors[name] = 'FAIL: fixture is not seeded; run seed\nprivate pubkyauth://secret?token=hidden'
        result = self.manager.status("seller")
        self.assertEqual(result['reason'], 'fixture-not-seeded')
        self.assertNotIn('hidden', json.dumps(result))
        self.assertNotIn('pubkyauth', json.dumps(result))
        self.assertEqual(self.docker.starts, 1)

    def test_cleanup_is_exact_and_private_state_contains_no_grant_url(self):
        self.manager.start("seller", [])
        path = self.manager.path("seller")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.manager.directory.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("auth_url", path.read_text())
        self.docker.containers["unrelated"] = {}
        self.assertEqual(self.manager.cleanup(), {"removed": ["seller"]})
        self.assertEqual(set(self.docker.containers), {"unrelated"})

    def test_unknown_operation_status_has_no_side_effect(self):
        with self.assertRaises(ValueError):
            self.manager.status("unknown")
        self.assertEqual(self.docker.starts, 0)


if __name__ == "__main__":
    unittest.main()
