#!/usr/bin/env python3
"""Touch one current iOS identifier and refresh; never repeat an input."""
import argparse
import json
import subprocess


def command(simulator, tool, args):
    result = subprocess.run(
        ["xcodebuildmcp", "ui-automation", tool, "--simulator-id", simulator,
         "--output", "json", "--verbose", *args],
        capture_output=True, text=True, timeout=45,
    )
    response = json.loads(result.stdout)
    if response.get("didError") is not False or result.returncode:
        raise RuntimeError(json.dumps(response))
    return response


def touch(simulator, identifier, invoke=command):
    before = invoke(simulator, "wait-for-ui", [
        "--identifier", identifier, "--predicate", "enabled", "--timeout-ms", "30000",
    ])
    elements = before["data"]["capture"]["elements"]
    targets = [e for e in elements if e.get("identifier") == identifier
               and "touch" in e.get("actions", [])]
    if len(targets) != 1:
        raise RuntimeError(f"Expected one touch target for {identifier}")
    # A successful touch can have a failed automatic capture. Wait for a fresh
    # snapshot separately; repeating the touch could approve or toggle twice.
    invoke(simulator, "touch", ["--element-ref", targets[0]["ref"], "--down", "--up"])
    return invoke(simulator, "wait-for-ui", [
        "--predicate", "settled", "--timeout-ms", "30000",
    ])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--simulator", required=True)
    parser.add_argument("--identifier", required=True)
    args = parser.parse_args()
    print(json.dumps(touch(args.simulator, args.identifier)))
