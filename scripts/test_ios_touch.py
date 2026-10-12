import unittest
from ios_touch import touch


class TouchTests(unittest.TestCase):
    def test_refreshes_after_successful_touch_with_missing_capture(self):
        calls = []

        def invoke(simulator, tool, args):
            calls.append((tool, args))
            if len(calls) == 1:
                return {"data": {"capture": {"elements": [
                    {"identifier": "ProbeTap", "ref": "e9", "actions": ["touch"]}
                ]}}}
            if tool == "touch":
                return {"didError": False, "data": {"uiError": {"code": "SNAPSHOT_MISSING"}}}
            return {"didError": False, "data": {"capture": {"screenHash": "fresh"}}}

        result = touch("owned-simulator", "ProbeTap", invoke)
        self.assertEqual([c[0] for c in calls], ["wait-for-ui", "touch", "wait-for-ui"])
        self.assertEqual(calls[1][1], ["--element-ref", "e9", "--down", "--up"])
        self.assertEqual(result["data"]["capture"]["screenHash"], "fresh")

    def test_does_not_touch_ambiguous_targets(self):
        target = {"identifier": "ProbeTap", "ref": "e9", "actions": ["touch"]}
        with self.assertRaises(RuntimeError):
            touch("owned-simulator", "ProbeTap", lambda *args: {
                "data": {"capture": {"elements": [target, target]}}
            })

    def test_does_not_repeat_touch_when_post_action_wait_fails(self):
        calls = []

        def invoke(simulator, tool, args):
            calls.append(tool)
            if len(calls) == 1:
                return {"data": {"capture": {"elements": [
                    {"identifier": "ProbeTap", "ref": "e1", "actions": ["touch"]}
                ]}}}
            if tool == "touch":
                return {"didError": False}
            raise RuntimeError("WAIT_TIMEOUT")

        with self.assertRaises(RuntimeError):
            touch("owned-simulator", "ProbeTap", invoke)
        self.assertEqual(calls, ["wait-for-ui", "touch", "wait-for-ui"])
