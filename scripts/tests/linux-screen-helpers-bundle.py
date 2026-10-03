#!/usr/bin/env python3
"""Exercise a real payload after relocation with no helpers on PATH.

Usage: python3 scripts/tests/linux-screen-helpers-bundle.py [--verify-only] BUNDLE.tar.gz
       python3 scripts/tests/linux-screen-helpers-bundle.py --binary HAND BUNDLE.tar.gz
--verify-only checks archive integrity without running helpers (build-time).
--architecture requires the bundle and ELF machine to match the Cargo target.
--binary additionally requires the exact verified payload in the shipped Hand.
Checks the public manifest contract, DT_NEEDED resolution via the bundled
loader, real upstream help, and rejection of a tampered payload. Does not
require a compositor/session and is not evidence of successful screen capture.
"""
import argparse
import gzip
import hashlib
import json
import mmap
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
from contextlib import contextmanager

ARCHITECTURES = {
    'x86_64': ('ld-linux-x86-64.so.2', b'\x3e\x00'),
    'aarch64': ('ld-linux-aarch64.so.1', b'\xb7\x00'),
}


@contextmanager
def verified_tar(archive):
    # tarfile's streaming gzip reader does not check the gzip trailer. Drain a
    # real GzipFile first so CRC/truncation/trailing-stream damage fails closed,
    # with a bound on decompression even for a hostile concatenated gzip stream.
    with tempfile.TemporaryFile() as expanded:
        with gzip.open(archive, 'rb') as source:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > 130 * 1024 * 1024:
                    raise ValueError('decompressed archive size limit')
                expanded.write(chunk)
        expanded.seek(0)
        with tarfile.open(fileobj=expanded, mode='r|') as tar:
            yield tar


def extract_and_verify(archive, root):
    if archive.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('compressed size limit')
    with verified_tar(archive) as tar:
        paths = set()
        total = 0
        for index, member in enumerate(tar):
            if index == 0 and member.name != "manifest.json":
                raise ValueError("manifest must be the first archive entry")
            if index > 512:
                raise ValueError('file count limit')
            total += member.size
            if total > 128 * 1024 * 1024:
                raise ValueError('expanded size limit')
            path = PurePosixPath(member.name)
            if (not member.isfile() or path.is_absolute() or '..' in path.parts
                or str(path) != member.name or '\\' in member.name
                or any(ord(c) < 32 or ord(c) == 127 for c in member.name)
                or len(member.name) > 512 or len(path.parts) > 8 or member.name in paths):
                raise ValueError('unsafe archive member')
            if member.name == 'manifest.json' and member.size > 1024 * 1024:
                raise ValueError('manifest size limit')
            if member.mode not in (0o644, 0o755):
                raise ValueError('unsupported file mode')
            paths.add(member.name)
            dest = root / member.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, dest.open('wb') as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
            dest.chmod(member.mode)
        if not paths:
            raise ValueError('empty archive')
    manifest = json.loads((root / 'manifest.json').read_text())
    if type(manifest['version']) is not int or manifest['version'] != 1 or manifest['architecture'] not in ARCHITECTURES:
        raise ValueError('manifest version/architecture')
    if not isinstance(manifest['files'], list) or len(manifest['files']) > 512:
        raise ValueError('manifest file count limit')
    declared = set()
    for file in manifest['files']:
        path = file['path']
        if (path in declared or path not in paths or path == 'manifest.json'
            or file['mode'] not in (0o644, 0o755)
            or not re.fullmatch('[0-9a-fA-F]{64}', file['sha256'])
            or type(file['bytes']) is not int or file['bytes'] < 0):
            raise ValueError('invalid manifest paths')
        declared.add(path)
        target = root / path
        if (hashlib.sha256(target.read_bytes()).hexdigest() != file['sha256'].lower()
            or target.stat().st_size != file['bytes']
            or (target.stat().st_mode & 0o777) != file['mode']):
            raise ValueError('file hash/size/mode mismatch: ' + path)
    if declared != paths - {'manifest.json'}:
        raise ValueError('undeclared file')
    loader, elf_machine = ARCHITECTURES[manifest['architecture']]
    executables = {'bin/waymote-streamd', 'bin/grim', 'lib/' + loader}
    required = executables | {'upstream.json'}
    if not required <= declared or not any(p.startswith('licenses/') for p in declared):
        raise ValueError('missing required helper/provenance')
    for file in manifest['files']:
        if file['path'] in executables:
            with (root / file['path']).open('rb') as binary:
                header = binary.read(20)
            if file['mode'] != 0o755 or not header.startswith(b'\x7fELF\x02\x01') or header[18:20] != elf_machine:
                raise ValueError('required helper is not an executable ' + manifest['architecture'] + ' ELF file')
    if any(re.search(r'(^|/)(ffmpeg|labwc|weston)(\.|$)', p) for p in paths):
        raise ValueError('unexpected system component')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--architecture', choices=ARCHITECTURES, help='Require this target architecture')
    parser.add_argument('--binary', type=Path)
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve()
    with tempfile.TemporaryDirectory(prefix='screen helpers relocation ') as temp:
        base = Path(temp)
        first = base / 'original'
        manifest = extract_and_verify(archive, first)
        if args.architecture and manifest['architecture'] != args.architecture:
            raise ValueError('bundle does not match target architecture: ' + args.architecture)
        if args.binary:
            with args.binary.open('rb') as hand, mmap.mmap(hand.fileno(), 0, access=mmap.ACCESS_READ) as binary:
                if binary.find(archive.read_bytes()) < 0:
                    raise ValueError('shipped Hand does not contain the exact verified screen helper payload')
            print(json.dumps({'binary':str(args.binary), 'embedded_payload_sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}), flush=True)
        if args.verify_only:
            print(json.dumps({'status':'verified', 'files':len(manifest['files'])}))
            return
        relocated = base / 'relocated payload'
        first.rename(relocated)
        empty_path = base / 'empty PATH'; empty_path.mkdir()
        env = {'PATH':str(empty_path), 'LC_ALL':'C', 'HOME':str(base)}
        loader = relocated / 'lib' / ARCHITECTURES[manifest['architecture']][0]
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
