#!/usr/bin/env python3
"""CLI journeys with synthetic SDKs; real Apple SDK export/build is a separate validation."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

SCRIPTS = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--appimage', help='Optional existing pinned real AppImage for installer recovery journey')
    args = parser.parse_args()
    evidence = SCRIPTS.parents[1] / 'output/ios-sdk'
    evidence.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix='nanocodex-sdk-test-') as temp:
        temp = Path(temp)
        tools = temp / 'tools'
        tools.mkdir()
        fake = tools / 'xtool'
        fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, platform, shutil, struct, sys
if sys.argv[1:] == ['--version']:
    print('xtool 1.20.1'); sys.exit()
if sys.argv[1:3] == ['sdk', 'build']:
    root = pathlib.Path(sys.argv[4]) / 'darwin.xtoolsdk'
    root.mkdir()
    (root / 'info.json').write_text(json.dumps({'schemaVersion': '1.0', 'artifacts': {'darwin': {'type': 'swiftSDK', 'variants': [{'path': '.'}]}}}))
    (root / 'darwin-sdk-version.txt').write_text('epoch=2,darwinTools=1.1.0,oam=1.3.0')
    (root / 'toolset.json').write_text(json.dumps({'schemaVersion': '1.0', 'rootPath': 'toolset/bin', 'linker': {'path': 'ld64.lld'}, 'librarian': {'path': 'llvm-lib'}}))
    ios = 'Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.2.sdk'
    (root / ios).mkdir(parents=True)
    (root / 'swift-sdk.json').write_text(json.dumps({'schemaVersion': '4.0', 'targetTriples': {'arm64-apple-ios': {'sdkRootPath': ios}}}))
    lib = root / 'Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib'
    (lib / 'swift').mkdir(parents=True)
    (lib / 'clang/17').mkdir(parents=True)
    (lib / 'swift/clang').symlink_to('../clang/17')
    tools = root / 'toolset/bin'
    tools.mkdir(parents=True)
    header = bytearray(64)
    header[:6] = bytes([127, 69, 76, 70, 2, 1])
    header[18:20] = struct.pack('<H', 62 if platform.machine() == 'x86_64' else 183)
    for name in ('llvm-lib', 'dsymutil', 'ld64.lld'):
        (tools / name).write_bytes(header)
        (tools / name).chmod(0o755)
    (root / 'payload').write_text('synthetic SDK')
    (root / 'inside').symlink_to('payload')
    (root / 'chain').symlink_to('inside')
    (root / 'hard').hardlink_to(root / 'payload')
    (root / 'nested').mkdir()
    (root / 'nested/back').symlink_to('../payload')
    sys.exit()
if sys.argv[1:3] == ['sdk', 'install']:
    if os.environ.get('FAIL_INSTALL'):
        sys.exit(42)
    root = pathlib.Path(os.environ['XDG_CONFIG_HOME']) / 'swiftpm/swift-sdks/darwin.artifactbundle'
    root.parent.mkdir(parents=True)
    shutil.copytree(sys.argv[3], root, symlinks=True)
    sys.exit()
sys.exit(2)
''')
        fake.chmod(0o755)
        env = dict(os.environ, XDG_CONFIG_HOME=str(temp / 'config'), NANOCODEX_XTOOL=str(fake))
        destination = temp / 'config/swiftpm/swift-sdks/darwin.artifactbundle'
        destination.mkdir(parents=True)
        (destination / 'old').write_text('existing SDK')

        def run(name, command, success=True, extra=None):
            process = subprocess.run(command, env=dict(env, **(extra or {})), text=True, capture_output=True)
            (evidence / (name + '.log')).write_text('$ ' + ' '.join(map(str, command)) + '\n' + process.stdout + process.stderr)
            assert (process.returncode == 0) == success, (name, process.returncode, process.stdout, process.stderr)
            results.append({'journey': name, 'exit': process.returncode, 'expected': 'success' if success else 'rejection'})
            return process

        xcode = temp / 'Xcode.app/Contents/Developer'
        xcode.mkdir(parents=True)
        archive = temp / 'sdk.tar.gz'
        run('export', ['bash', str(SCRIPTS / 'export-xtool-sdk-linux.sh'), str(xcode.parents[1]), str(archive)])
        assert archive.stat().st_mode & 0o777 == 0o600
        sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        repeated = temp / 'repeated.tar.gz'
        run('reproducible-export', ['bash', str(SCRIPTS / 'export-xtool-sdk-linux.sh'), str(xcode.parents[1]), str(repeated)])
        assert hashlib.sha256(repeated.read_bytes()).hexdigest() == sha
        base = ['bash', str(SCRIPTS / 'import-xtool-sdk-linux.sh'), str(archive), '--sha256', sha]
        run('checksum-rejection', base[:-1] + ['0' * 64], False)
        assert (destination / 'old').read_text() == 'existing SDK'
        run('install-failure-preserves-existing', base, False, {'FAIL_INSTALL': '1'})
        assert (destination / 'old').read_text() == 'existing SDK'
        backup = destination.with_name('.nanocodex-sdk-previous')
        destination.rename(backup)
        run('interrupted-swap-recovery', base, False, {'FAIL_INSTALL': '1'})
        assert (destination / 'old').read_text() == 'existing SDK' and not backup.exists()
        run('import', base)
        assert (destination / 'payload').read_text() == 'synthetic SDK'
        assert (destination / 'inside').read_text() == 'synthetic SDK'
        assert (destination / 'chain').read_text() == 'synthetic SDK'
        assert (destination / 'nested/back').read_text() == 'synthetic SDK'
        assert (destination / 'hard').read_text() == 'synthetic SDK'
        assert not (destination / 'old').exists()
        def repack(name, omit=None, inject=None):
            path = temp / (name + '.tar.gz')
            with tarfile.open(archive, 'r:gz') as source, tarfile.open(path, 'w:gz') as output:
                for item in source:
                    if omit and item.name.endswith(omit):
                        continue
                    output.addfile(item, source.extractfile(item) if item.isfile() else None)
                if inject:
                    item = tarfile.TarInfo(inject)
                    item.type = tarfile.DIRTYPE
                    output.addfile(item)
            pin = hashlib.sha256(path.read_bytes()).hexdigest()
            return ['bash', str(SCRIPTS / 'import-xtool-sdk-linux.sh'), str(path), '--sha256', pin]
        run('upstream-standard-export-import', repack('upstream-standard', omit='nanocodex-sdk.json'))
        assert (destination / 'payload').read_text() == 'synthetic SDK'
        run('upstream-missing-structural-metadata', repack('upstream-incomplete', omit='toolset.json'), False)
        run('installed-clang-layout-rejection', repack('injected-headers', inject='darwin.xtoolsdk/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/17/include'), False)
        wrong_arch = temp / 'wrong-tool-arch.tar.gz'
        with tarfile.open(archive, 'r:gz') as source, tarfile.open(wrong_arch, 'w:gz') as output:
            for item in source:
                if item.name.endswith('nanocodex-sdk.json'):
                    continue
                if item.isfile():
                    data = source.extractfile(item).read()
                    if item.name.endswith('toolset/bin/llvm-lib'):
                        data = data[:18] + b'\xff\xff' + data[20:]
                    output.addfile(item, io.BytesIO(data))
                else:
                    output.addfile(item)
        run('native-tool-architecture-rejection', ['bash', str(SCRIPTS / 'import-xtool-sdk-linux.sh'), str(wrong_arch), '--sha256', hashlib.sha256(wrong_arch.read_bytes()).hexdigest()], False)

        assert (destination / 'payload').read_text() == 'synthetic SDK'

        run('trusted-local-install-failure', ['python3', str(SCRIPTS / 'xtool-sdk-linux.py'), 'install', str(xcode.parents[1])], False, {'FAIL_INSTALL': '1'})
        assert (destination / 'payload').read_text() == 'synthetic SDK'
        run('export-refuses-overwrite', ['bash', str(SCRIPTS / 'export-xtool-sdk-linux.sh'), str(xcode.parents[1]), str(archive)], False)
        run('artifactbundle-is-not-xcode', ['bash', str(SCRIPTS / 'export-xtool-sdk-linux.sh'), str(destination), str(temp / 'invalid.tar.gz')], False)

        def malicious(name, entries):
            path = temp / (name + '.tar.gz')
            with tarfile.open(path, 'w:gz') as tar:
                root = tarfile.TarInfo('darwin.xtoolsdk')
                root.type = tarfile.DIRTYPE
                tar.addfile(root)
                for member, kind, value in entries:
                    item = tarfile.TarInfo(member)
                    item.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        item.linkname = value
                        tar.addfile(item)
                    elif kind == tarfile.REGTYPE:
                        data = value.encode()
                        item.size = len(data)
                        tar.addfile(item, io.BytesIO(data))
                    else:
                        tar.addfile(item)
            pin = hashlib.sha256(path.read_bytes()).hexdigest()
            run(name, ['bash', str(SCRIPTS / 'import-xtool-sdk-linux.sh'), str(path), '--sha256', pin], False)
            assert (destination / 'payload').read_text() == 'synthetic SDK'
            assert not (temp / 'escape').exists()

        malicious('traversal', [('darwin.xtoolsdk/../escape', tarfile.REGTYPE, 'escape')])
        malicious('absolute-path', [('/escape', tarfile.REGTYPE, 'escape')])
        malicious('symlink-escape', [('darwin.xtoolsdk/link', tarfile.SYMTYPE, '../../escape')])
        malicious('symlink-child', [('darwin.xtoolsdk/link', tarfile.SYMTYPE, 'payload'), ('darwin.xtoolsdk/link/child', tarfile.REGTYPE, 'escape')])
        malicious('symlink-dotdot-after-expansion', [('darwin.xtoolsdk/a', tarfile.SYMTYPE, 'b/../escape'), ('darwin.xtoolsdk/b', tarfile.SYMTYPE, '.')])
        malicious('symlink-cycle', [('darwin.xtoolsdk/a', tarfile.SYMTYPE, 'b'), ('darwin.xtoolsdk/b', tarfile.SYMTYPE, 'a')])
        malicious('hardlink-escape', [('darwin.xtoolsdk/link', tarfile.LNKTYPE, '../escape')])
        malicious('special-device', [('darwin.xtoolsdk/device', tarfile.CHRTYPE, '')])
        malicious('duplicate-member', [('darwin.xtoolsdk/file', tarfile.REGTYPE, 'a'), ('darwin.xtoolsdk/file', tarfile.REGTYPE, 'b')])
        malicious('artifactbundle-archive', [('darwin.artifactbundle/file', tarfile.REGTYPE, 'a')])
        malicious('wrong-architecture', [('darwin.xtoolsdk/nanocodex-sdk.json', tarfile.REGTYPE, json.dumps({'format': 1, 'architecture': 'not-this-host', 'xtool': '1.20.1'}))])

        curl = tools / 'curl'
        curl.write_text('''#!/usr/bin/env python3
import os, pathlib, shutil, sys
out = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
if os.environ.get('FAIL_DOWNLOAD'):
    out.write_text('truncated'); print('secret-url-should-not-leak', file=sys.stderr); sys.exit(22)
shutil.copyfile(os.environ['FIXTURE_DOWNLOAD'], out)
''')
        curl.chmod(0o755)
        download_env = {'PATH': str(tools) + ':' + env['PATH'], 'SDK_URL': 'https://synthetic.invalid/private?secret=synthetic', 'FIXTURE_DOWNLOAD': str(archive)}
        downloaded = temp / 'download.tar.gz'
        downloaded.write_text('prior bad download')
        download_cmd = ['python3', str(SCRIPTS / 'xtool-sdk-linux.py'), 'download', str(downloaded), '--sha256', sha]
        result = run('failed-download-cleans-partial', download_cmd, False, dict(download_env, FAIL_DOWNLOAD='1'))
        assert 'secret' not in result.stdout + result.stderr
        assert downloaded.read_text() == 'prior bad download'
        assert not list(temp.glob('.sdk-download-*'))
        run('download-checksum-rejection', download_cmd[:-1] + ['0' * 64], False, download_env)
        assert downloaded.read_text() == 'prior bad download'
        run('download-recovery', download_cmd, True, download_env)
        assert hashlib.sha256(downloaded.read_bytes()).hexdigest() == sha
        assert not list(temp.glob('.sdk-download-*'))
        run('verified-download-reuse', download_cmd, True, dict(download_env, FAIL_DOWNLOAD='1'))
        assert not list(temp.glob('config/swiftpm/swift-sdks/.nanocodex-sdk-*'))
        if not shutil.which('swift'):
            swift = tools / 'swift'
            swift.write_text('#!/bin/sh\necho synthetic-Swift-6.4\n')
            swift.chmod(0o755)
            env['PATH'] = str(tools) + ':' + env['PATH']
        if not shutil.which('clang', path=env['PATH']):
            clang = tools / 'clang'
            clang.write_text('#!/bin/sh\necho synthetic-Clang\n')
            clang.chmod(0o755)
        first = run('cache-key', ['python3', str(SCRIPTS / 'xtool-sdk-linux.py'), 'cache-key', '--sha256', sha])
        changed = run('cache-key-digest-changes', ['python3', str(SCRIPTS / 'xtool-sdk-linux.py'), 'cache-key', '--sha256', '0' * 64])
        assert first.stdout != changed.stdout and 'xtool-1.20.1' in first.stdout and sha in first.stdout

        # Optional: exercise the actual AppImage extraction without touching a live prefix.
        if args.appimage:
            install_env = dict(download_env, NANOCODEX_XTOOL_PREFIX=str(temp / 'install'))
            install_cmd = ['bash', str(SCRIPTS / 'install-xtool-linux.sh')]
            run('appimage-failed-download', install_cmd, False, dict(install_env, FAIL_DOWNLOAD='1'))
            assert not (temp / 'install/squashfs-root').exists()
            run('appimage-checksum-rejection', install_cmd, False, install_env)
            assert not (temp / 'install/squashfs-root').exists()
            (temp / 'install/squashfs-root').mkdir()
            (temp / 'install/squashfs-root/partial').write_text('interrupted extraction')
            run('appimage-real-recovery', install_cmd, True, dict(install_env, FIXTURE_DOWNLOAD=str(Path(args.appimage).resolve())))
            assert not (temp / 'install/squashfs-root/partial').exists()
            assert not list((temp / 'install').glob('.install-*'))
    (evidence / 'summary.json').write_text(json.dumps({'status': 'passed', 'journeys': results, 'boundary': 'synthetic SDK / mocked xtool; optional real pinned AppImage extraction'}, indent=2) + '\n')
    print(f'PASS: {len(results)} CLI journeys; evidence: {evidence}')


if __name__ == '__main__':
    main()
