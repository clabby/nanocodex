#!/usr/bin/env python3
"""Exercise a real payload after relocation with no helpers on PATH.

Usage: python3 scripts/tests/linux-screen-helpers-bundle.py BUNDLE.tar.gz
Checks the public manifest contract, DT_NEEDED resolution via the bundled
loader, real upstream help, and rejection of a tampered payload. Does not
require a compositor/session and is not evidence of successful screen capture.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile


def extract_and_verify(archive, root):
    if archive.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('compressed size limit')
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        if not members or members[0].name != "manifest.json":
            raise ValueError("manifest must be the first archive entry")
        paths = set()
        if sum(m.size for m in members) > 128 * 1024 * 1024:
            raise ValueError('expanded size limit')
        for member in members:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts or member.name in paths:
                raise ValueError('unsafe archive member')
            paths.add(member.name)
            dest = root / member.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(tar.extractfile(member).read())
            dest.chmod(member.mode)
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest['version'] != 1 or manifest['architecture'] != 'x86_64':
        raise ValueError('manifest version/architecture')
    declared = set()
    for file in manifest['files']:
        path = file['path']
        if path in declared or path not in paths or path == 'manifest.json':
            raise ValueError('invalid manifest paths')
        declared.add(path)
        target = root / path
        if (hashlib.sha256(target.read_bytes()).hexdigest() != file['sha256']
            or target.stat().st_size != file['bytes']
            or (target.stat().st_mode & 0o777) != file['mode']):
            raise ValueError('file hash/size/mode mismatch: ' + path)
    if declared != paths - {'manifest.json'}:
        raise ValueError('undeclared file')
    required = {'bin/waymote-streamd', 'bin/grim', 'lib/ld-linux-x86-64.so.2', 'upstream.json'}
    if not required <= declared or not any(p.startswith('licenses/') for p in declared):
        raise ValueError('missing required helper/provenance')
    if any(re.search(r'(^|/)(ffmpeg|labwc|weston)(\.|$)', p) for p in paths):
        raise ValueError('unexpected system component')
    return manifest


def main():
    archive = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='screen helpers relocation ') as temp:
        base = Path(temp)
        first = base / 'original'
        manifest = extract_and_verify(archive, first)
        relocated = base / 'relocated payload'
        first.rename(relocated)
        empty_path = base / 'empty PATH'; empty_path.mkdir()
        env = {'PATH':str(empty_path), 'LC_ALL':'C', 'HOME':str(base)}
        loader = relocated / 'lib/ld-linux-x86-64.so.2'
        for helper, option, marker in [('waymote-streamd', '--help', 'waymote'), ('grim', '-h', 'grim')]:
            command = [str(loader), '--inhibit-cache', '--library-path', str(relocated / 'lib')]
            resolved = subprocess.run(command + ['--list', str(relocated / 'bin' / helper)],
                                      env=env, text=True, capture_output=True, check=True, timeout=15)
            listing = resolved.stdout + resolved.stderr
            for path in re.findall(r'=>\s+(/.*?)\s+\(0x', listing):
                if not Path(path).is_relative_to(relocated / 'lib'):
                    raise AssertionError('host library dependency: ' + path)
            print(f'{helper} bundled DT_NEEDED:\n{listing}', flush=True)
            result = subprocess.run(command + [str(relocated / 'bin' / helper), option],
                                    env=env, text=True, capture_output=True, check=True, timeout=15)
            text = result.stdout + result.stderr
            assert marker in text.lower(), text
            print(f'{helper} {option} (clean PATH):\n{text}', flush=True)
        # Repack a corrupted real payload and exercise the same verifier.
        target = relocated / 'bin/grim'
        target.write_bytes(target.read_bytes() + b'tampered')
        corrupt = base / 'corrupt.tar.gz'
        with tarfile.open(corrupt, 'w:gz') as tar:
            ordered = [relocated / 'manifest.json'] + [p for p in sorted(relocated.rglob('*')) if p.name != 'manifest.json']
            for path in ordered:
                if path.is_file():
                    tar.add(path, arcname=path.relative_to(relocated).as_posix())
        try:
            extract_and_verify(corrupt, base / 'rejected')
        except ValueError as error:
            assert 'hash/size/mode mismatch' in str(error), error
            print('Tampered payload rejected:', error)
        else:
            raise AssertionError('tampered bundle accepted')
        print(json.dumps({'status':'passed', 'files':len(manifest['files']), 'relocation':True,
                          'clean_path':True, 'capture_tested':False}))


if __name__ == '__main__':
    main()
