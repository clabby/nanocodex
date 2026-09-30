#!/usr/bin/env python3
"""Private, checksum-pinned SDK transport. Never treats an installed bundle as an export."""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile

VERSION = '1.20.1'
ROOT = 'darwin.xtoolsdk'
MANIFEST = 'nanocodex-sdk.json'


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def checksum(value):
    value = value.lower()
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('SHA-256 must be 64 hexadecimal characters')
    return value


def architecture():
    machine = platform.machine()
    if machine not in ('x86_64', 'aarch64'):
        raise ValueError('Unsupported Linux architecture')
    return machine


def xtool(path):
    if subprocess.check_output([path, '--version'], text=True).strip() != f'xtool {VERSION}':
        raise ValueError('Unexpected xtool version')
    return path


def member_path(name):
    if '\\' in name or '\0' in name or name.startswith('/'):
        raise ValueError('Unsafe archive member path')
    parts = PurePosixPath(name).parts
    if not parts or '..' in parts or parts[0] != ROOT:
        raise ValueError('Archive must contain only darwin.xtoolsdk without traversal')
    return '/'.join(parts)


def link_parts(name, target, hard=False):
    if not target or target.startswith('/') or '\\' in target or '\0' in target:
        raise ValueError('Unsafe archive link target')
    parts = [] if hard else list(PurePosixPath(name).parent.parts)
    return parts + list(PurePosixPath(target).parts)


def validate(archive):
    """Validate the entire archive before creating even one extracted member."""
    members = {}
    links = {}
    for item in archive:
        name = member_path(item.name)
        if name in members:
            raise ValueError('Duplicate archive member')
        if not (item.isdir() or item.isfile() or item.issym() or item.islnk()):
            raise ValueError('Special archive members are forbidden')
        members[name] = item
        if item.issym() or item.islnk():
            links[name] = link_parts(name, item.linkname, item.islnk())
    if ROOT not in members or not members[ROOT].isdir():
        raise ValueError('Missing darwin.xtoolsdk directory')
    for name in members:
        for parent in PurePosixPath(name).parents:
            parent = str(parent)
            if parent in members and not members[parent].isdir():
                raise ValueError('Archive member descends through a non-directory or link')
    resolved = {}
    for name, target in links.items():
        # Model POSIX path walking: a symlink must be expanded BEFORE a following
        # '..'. Lexically normalizing b/../x first can hide an escape through b.
        pending = list(target)
        parts = []
        seen = {name}
        while pending:
            part = pending.pop(0)
            if part == '..':
                if len(parts) <= 1:
                    raise ValueError('Archive link escapes SDK root')
                parts.pop()
                continue
            if part == '.':
                continue
            parts.append(part)
            if parts[0] != ROOT:
                raise ValueError('Archive link escapes SDK root')
            prefix = '/'.join(parts)
            if prefix in links:
                if prefix in seen:
                    raise ValueError('Cyclic archive links')
                seen.add(prefix)
                pending = list(links[prefix]) + pending
                parts = []
        target = '/'.join(parts)
        if not parts or parts[0] != ROOT:
            raise ValueError('Archive link escapes SDK root')
        if members[name].islnk() and (target not in members or not members[target].isfile()):
            raise ValueError('Hard link must resolve to a regular archive member')
        resolved[name] = target
    return members, resolved


def extract(archive_path, destination):
    with tarfile.open(archive_path, 'r:*') as archive:
        members, links = validate(archive)
        for name, item in sorted(members.items(), key=lambda p: len(PurePosixPath(p[0]).parts)):
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if item.isdir():
                path.mkdir(exist_ok=True)
            elif item.isfile():
                with archive.extractfile(item) as source, path.open('xb') as target:
                    shutil.copyfileobj(source, target)
                path.chmod(item.mode & 0o777)
        for name, item in members.items():
            if item.issym():
                os.symlink(item.linkname, destination / name)
            elif item.islnk():
                os.link(destination / links[name], destination / name)


SDK_VERSION = 'epoch=2,darwinTools=1.1.0,oam=1.3.0'


def sdk_metadata(sdk):
    """Accept upstream exports; our optional transport metadata is not required."""
    manifest = sdk / MANIFEST
    if manifest.exists() or manifest.is_symlink():
        if not manifest.is_file() or manifest.is_symlink():
            raise ValueError('Invalid private SDK export metadata')
        if json.loads(manifest.read_text()) != {'format': 1, 'architecture': architecture(), 'xtool': VERSION}:
            raise ValueError('SDK export architecture/version mismatch')
    for name in ('info.json', 'darwin-sdk-version.txt', 'toolset.json', 'swift-sdk.json'):
        path = sdk / name
        if not path.is_file() or path.is_symlink():
            raise ValueError('Missing upstream SDK metadata')
    info = json.loads((sdk / 'info.json').read_text())
    artifact = info.get('artifacts', {}).get('darwin', {})
    if info.get('schemaVersion') != '1.0' or artifact.get('type') != 'swiftSDK' or not any(
            variant.get('path') == '.' for variant in artifact.get('variants', [])):
        raise ValueError('Invalid upstream SDK artifact metadata')
    if (sdk / 'darwin-sdk-version.txt').read_text().strip() != SDK_VERSION:
        raise ValueError('SDK builder version is incompatible with pinned xtool')
    toolset = json.loads((sdk / 'toolset.json').read_text())
    if (toolset.get('schemaVersion') != '1.0' or toolset.get('rootPath') != 'toolset/bin'
            or toolset.get('linker', {}).get('path') != 'ld64.lld'
            or toolset.get('librarian', {}).get('path') != 'llvm-lib'):
        raise ValueError('Invalid upstream SDK toolset metadata')
    definition = json.loads((sdk / 'swift-sdk.json').read_text())
    ios = definition.get('targetTriples', {}).get('arm64-apple-ios', {})
    sdk_root = ios.get('sdkRootPath', '')
    parts = PurePosixPath(sdk_root).parts
    if (definition.get('schemaVersion') != '4.0' or not parts or sdk_root.startswith('/')
            or '..' in parts or not (sdk / sdk_root).is_dir()):
        raise ValueError('Invalid upstream iPhoneOS SDK definition')
    toolchain = sdk / 'Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib'
    # swift/clang is normally ../clang/17. Path.exists follows that symlink,
    # catching headers injected by DarwinSDK.addHostClangResourceDir at install.
    candidates = [toolchain / 'swift/clang/include', *toolchain.glob('clang/*/include')]
    if any(path.exists() or path.is_symlink() for path in candidates):
        raise ValueError('Installed artifactbundle is not a reusable SDK export')
    expected = 62 if architecture() == 'x86_64' else 183
    tools = sdk / 'toolset/bin'
    for name in ('llvm-lib', 'dsymutil', 'ld64.lld'):
        path = tools / name
        if not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError('Missing native SDK tool')
        with path.open('rb') as binary:
            header = binary.read(20)
        # Upstream's linker can be a shell wrapper around orig/ld64.lld.
        if name == 'ld64.lld' and header.startswith(b'#!'):
            path = tools / 'orig/ld64.lld'
            if not path.is_file() or not os.access(path, os.X_OK):
                raise ValueError('Missing native SDK linker behind wrapper')
            with path.open('rb') as binary:
                header = binary.read(20)
        if (len(header) < 20 or header[:5] != b'\x7fELF\x02' or header[5] not in (1, 2)
                or struct.unpack('<H' if header[5] == 1 else '>H', header[18:20])[0] != expected):
            raise ValueError('Native SDK tool architecture mismatch')


def sdk_directory():
    config = os.environ.get('XDG_CONFIG_HOME')
    if config:
        if not Path(config).is_absolute():
            raise ValueError('XDG_CONFIG_HOME must be absolute')
        return Path(config) / 'swiftpm/swift-sdks'
    return Path.home() / '.swiftpm/swift-sdks'


def import_sdk(args):
    if args.command == 'import':
        expected = checksum(args.sha256)
        if digest(args.archive) != expected:
            raise ValueError('SDK checksum mismatch; existing installation untouched')
    executable = xtool(args.xtool)
    destination = sdk_directory()
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / '.nanocodex-sdk.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        final = destination / 'darwin.artifactbundle'
        backup = destination / '.nanocodex-sdk-previous'
        # Recover an interrupted two-rename swap before doing any new staging.
        if backup.exists():
            if not final.exists():
                backup.rename(final)
            else:
                shutil.rmtree(backup)
        with tempfile.TemporaryDirectory(prefix='.nanocodex-sdk-', dir=destination) as stage:
            stage = Path(stage)
            if args.command == 'import':
                extract(args.archive, stage)
                sdk = stage / ROOT
                sdk_metadata(sdk)
            else:
                sdk = Path(args.input).absolute()
                if not sdk.exists():
                    raise ValueError('SDK input does not exist')
                if sdk.name.endswith('.artifactbundle'):
                    raise ValueError('Installed artifactbundle is not a reusable SDK export')
                if sdk.is_dir() and sdk.name.endswith('.xtoolsdk'):
                    sdk_metadata(sdk)
            env = dict(os.environ, XDG_CONFIG_HOME=str(stage / 'config'))
            subprocess.run([executable, 'sdk', 'install', str(sdk), '--slim'], env=env, check=True)
            bundle = stage / 'config/swiftpm/swift-sdks/darwin.artifactbundle'
            if not bundle.is_dir() or not (bundle / 'info.json').is_file():
                raise ValueError('xtool did not produce an SDK bundle')
            if final.exists():
                final.rename(backup)
            try:
                bundle.rename(final)
            except BaseException:
                if backup.exists():
                    backup.rename(final)
                raise
            if backup.exists():
                shutil.rmtree(backup)
    print(f'Installed private Darwin SDK: {final}')


def export_sdk(args):
    executable = xtool(args.xtool)
    arch = args.architecture or architecture()
    source = Path(args.xcode).resolve()
    if not source.is_dir() or not (source / 'Contents/Developer').is_dir():
        raise ValueError('Export requires an existing Xcode.app tree (a pruned Linux tree is supported)')
    output = Path(args.output).absolute()
    if output.exists():
        raise ValueError('Refusing to overwrite an existing SDK export')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.sdk-export-', dir=output.parent) as stage:
        stage = Path(stage)
        subprocess.run([executable, 'sdk', 'build', str(source), str(stage), '--arch',
                        'arm64' if arch == 'aarch64' else 'x86_64'], check=True)
        sdk = stage / ROOT
        if not sdk.is_dir():
            raise ValueError('xtool did not export a darwin.xtoolsdk directory')
        (sdk / MANIFEST).write_text(json.dumps({'format': 1, 'architecture': arch, 'xtool': VERSION}) + '\n')
        archive_path = stage / 'sdk.tar.gz'
        def normalized(item):
            item.uid = item.gid = 0
            item.uname = item.gname = ''
            item.mtime = 0
            item.mode &= 0o777
            item.pax_headers = {}
            return item
        with archive_path.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w') as archive:
                archive.add(sdk, arcname=ROOT, filter=normalized)
        # SDK trees may contain links; validate our own export by the same rules.
        with tarfile.open(archive_path, 'r:gz') as archive:
            validate(archive)
        archive_path.chmod(0o600)
        os.link(archive_path, output)  # Atomic publication; never overwrites.
    print(f'{digest(output)}  {output.name}')


def download(args):
    expected = checksum(args.sha256)
    output = Path(args.output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file() and digest(output) == expected:
        print('Using verified SDK download')
        return
    url = os.environ.get(args.url_env, '')
    if not url.startswith('https://'):
        raise ValueError('Private SDK URL must be supplied as an HTTPS environment variable')
    fd, partial = tempfile.mkstemp(prefix='.sdk-download-', dir=output.parent)
    os.close(fd)
    try:
        # Keep URL and credentials out of both success and failure logs.
        result = subprocess.run(['curl', '--fail', '--location', '--silent', '--retry', '3',
                                 '--proto', '=https', '--proto-redir', '=https', url, '-o', partial],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise ValueError('Private SDK download failed; partial file discarded')
        if digest(partial) != expected:
            raise ValueError('SDK download checksum mismatch; partial file discarded')
        os.replace(partial, output)
    finally:
        if os.path.exists(partial):
            os.unlink(partial)
    print('Downloaded and verified private SDK archive')


def cache_key(args):
    h = hashlib.sha256()
    for command in (['swift', '--version'], ['clang', '--version']):
        h.update(subprocess.check_output(command, stderr=subprocess.STDOUT))
    print(f'ios-linux-sdk-v1-{architecture()}-xtool-{VERSION}-toolchain-{h.hexdigest()}-sdk-{checksum(args.sha256)}')


def main():
    if platform.system() != 'Linux':
        raise ValueError('SDK transport requires Linux')
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('export')
    p.add_argument('xcode')
    p.add_argument('output', help='Private .tar.gz export destination (must not exist)')
    p.add_argument('--architecture', choices=['x86_64', 'aarch64'])
    p.add_argument('--xtool', default=os.environ.get('NANOCODEX_XTOOL', 'xtool'))
    p.set_defaults(run=export_sdk)
    p = sub.add_parser('import')
    p.add_argument('archive')
    p.add_argument('--sha256', required=True)
    p.add_argument('--xtool', default=os.environ.get('NANOCODEX_XTOOL', 'xtool'))
    p.set_defaults(run=import_sdk)
    p = sub.add_parser('install', help='Stage a trusted local Xcode.xip, Xcode.app, or darwin.xtoolsdk input')
    p.add_argument('input')
    p.add_argument('--xtool', default=os.environ.get('NANOCODEX_XTOOL', 'xtool'))
    p.set_defaults(run=import_sdk)
    p = sub.add_parser('download')
    p.add_argument('output')
    p.add_argument('--sha256', required=True)
    p.add_argument('--url-env', default='SDK_URL')
    p.set_defaults(run=download)
    p = sub.add_parser('cache-key')
    p.add_argument('--sha256', required=True)
    p.set_defaults(run=cache_key)
    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, subprocess.SubprocessError, json.JSONDecodeError, TypeError, AttributeError) as error:
        # Do not print arbitrary exception text: subprocess argv can contain private inputs.
        message = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else 'SDK operation failed; existing installation preserved where possible'
        print(f'error: {message}', file=sys.stderr)
        sys.exit(1)
