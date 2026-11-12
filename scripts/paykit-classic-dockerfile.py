#!/usr/bin/env python3
"""Translate the supported upstream local Dockerfile for classic Docker builds."""

import json
import re
import sys
from pathlib import Path


def transform(text, server, paykit, patches):
    if not all(re.fullmatch('[0-9a-f]{40}', value) for value in (server, paykit)):
        raise ValueError('Full source revisions are required')
    lines = text.splitlines(keepends=True)
    output, index, named = [], 0, 0
    while index < len(lines):
        line = lines[index]
        if line.startswith('# syntax='):
            index += 1
            continue
        if line.startswith('RUN --mount=from=paykit-lib'):
            block = [line]
            while block[-1].rstrip().endswith('\\'):
                index += 1
                if index >= len(lines):
                    raise ValueError('Unterminated source mount block')
                block.append(lines[index])
            mounts, body = [], []
            for part in block:
                if '--mount=' in part:
                    mount = re.fullmatch(r'(?:RUN )?\s*--mount=from=(paykit-lib|paykit-sdk|locks),target=/contexts/\1,ro\s*\\\n', part)
                    if not mount or mount[1] in mounts:
                        raise ValueError('Unsupported named source contexts')
                    mounts.append(mount[1])
                else:
                    body.append(part)
            if not {'paykit-lib', 'paykit-sdk'} <= set(mounts) or not body:
                raise ValueError('Unsupported named source contexts')
            output += ['COPY paykit-rs/paykit-lib /contexts/paykit-lib\n',
                       'COPY paykit-rs/paykit-sdk /contexts/paykit-sdk\n']
            if 'locks' in mounts:
                output.append('COPY locks /contexts/locks\n')
            # Preserve the entire upstream shell body, including future checks
            # and preparation steps. Only the context transport changes.
            output.append('RUN ' + ''.join(body).lstrip())
            named += 1
        else:
            output.append(line)
        index += 1
    text = ''.join(output)
    text, copied = re.subn(r'^COPY \. /build/paykit-server$', 'COPY paykit-server /build/paykit-server', text, flags=re.M)
    text = re.sub(r'RUN --mount=type=cache[^\n]*\\\n(\s+--mount=type=cache[^\n]*\\\n)*', 'RUN ', text)
    if named != 1 or copied != 1 or '--mount' in text:
        raise ValueError('Dockerfile.local changed shape; update the classic builder')
    labels = {'tech.masivo.paykit-server': server, 'tech.masivo.paykit-rs': paykit, 'tech.masivo.paykit-server-patches': patches}
    return text + '\nLABEL ' + ' '.join(key + '=' + json.dumps(value) for key, value in labels.items()) + '\n'


if __name__ == '__main__':
    try:
        print(transform(Path(sys.argv[1]).read_text(), *sys.argv[2:5]), end='')
    except (ValueError, OSError) as error:
        sys.exit(str(error))
