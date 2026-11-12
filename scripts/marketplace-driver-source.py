#!/usr/bin/env python3
"""Hash the driver Dockerfile and every local COPY input; never traverse a home."""
import hashlib
from pathlib import Path
import shlex
import sys


def digest(root):
    root = Path(root).resolve(strict=True)
    dockerfile = root / 'Dockerfile'
    files = {'Dockerfile'}
    for line in dockerfile.read_text().replace('\\\n', ' ').splitlines():
        parts = shlex.split(line, comments=True)
        if not parts or parts[0].upper() != 'COPY':
            continue
        if parts[1].startswith('--from='):
            continue  # Those helpers have separately verified server/Paykit revision labels.
        if any(value.startswith('--') for value in parts[1:]) or len(parts) < 3:
            raise ValueError('Unsupported local Docker COPY; update the source identity helper')
        files.update(parts[1:-1])
    value = hashlib.sha256()
    for name in sorted(files):
        path = root / name
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(root) or not path.is_file():
            raise ValueError('Driver COPY must name bounded ordinary source files')
        content = path.read_bytes()
        value.update(name.encode() + b'\0' + str(len(content)).encode() + b'\0' + content)
    return value.hexdigest()


if __name__ == '__main__':
    try:
        print(digest(Path(sys.argv[1])))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
