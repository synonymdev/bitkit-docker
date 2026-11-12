#!/usr/bin/env python3
"""Select the supported invoice/lock policy from the verified pinned Locks source."""
import re
import sys
from pathlib import Path


def select(text):
    function = text.split("fn validate_paykit_payment_params(", 1)
    if len(function) != 2:
        raise ValueError("Unknown Locks payment-parameter validator")
    match = re.search(r'if\s+!matches!\(\s*key\.as_str\(\),\s*([^)]*)\)', function[1])
    if not match or not re.fullmatch(r'\s*"[a-z_]+"(?:\s*\|\s*"[a-z_]+")*\s*', match[1]):
        raise ValueError("Unknown Locks payment-parameter field validation")
    fields = re.findall(r'"([a-z_]+)"', match[1])
    if fields == ["recipient_pubky", "amount", "asset"]:
        return "legacy"
    if fields == ["recipient_pubky", "amount", "asset", "payment_in"]:
        return "payment-window-hours"
    raise ValueError("Unsupported Locks payment parameters: " + ", ".join(fields))


if __name__ == "__main__":
    try:
        print(select(Path(sys.argv[1]).read_text()))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
