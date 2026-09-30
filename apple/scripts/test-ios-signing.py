#!/usr/bin/env python3
"""Real zsign CLI journeys with synthetic profiles, never Apple-install validation.

Needs OpenSSL, clang, the pinned install-zsign-linux.sh build, and an iOS-enabled
ld64.lld (xtool darwin-tools-linux-llvm v1.1.0 supplies one). No SDK is needed.
No real signing identities are read. Generated keys and IPAs are removed;
only a sanitized transcript and synthetic signing report are retained.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--zsign', required=True, type=Path)
parser.add_argument('--clang', default='clang')
parser.add_argument('--linker', default='ld64.lld')
parser.add_argument('--output-dir', type=Path, default=ROOT / 'output/ios-signing')
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
trace = ['Synthetic self-signed identity only: no Apple trust or device-install claim.\n']


def command(argv, **kwargs):
    result = subprocess.run(list(map(str, argv)), capture_output=True, **kwargs)
    return result


try:
    with tempfile.TemporaryDirectory(prefix='synthetic-signing-') as work:
        temp = Path(work)

        def checked(argv):
            result = command(argv)
            trace.append('$ ' + ' '.join(map(str, argv)).replace(work, '$PRIVATE_TEST_DIR')
                         + f'\nexit={result.returncode}\n')
            assert result.returncode == 0, result.stderr.decode()
            return result.stdout

        key, cert = temp / 'key.pem', temp / 'cert.pem'
        # PEM-mode zsign only accepts known WWDR issuer *names*. A disposable
        # CA uses that public DN so the real signer can run, but its random key
        # is unrelated to Apple. The leaf retains an explicit synthetic CN.
        # Consequently this chain MUST NOT pass Apple trust verification.
        ca_key, ca_cert = temp / 'synthetic-ca-key.pem', temp / 'synthetic-ca.pem'
        checked(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', ca_key,
                 '-out', ca_cert, '-days', '1', '-subj',
                 '/CN=Apple Worldwide Developer Relations Certification Authority/OU=G3/O=Apple Inc./C=US'])
        checked(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
                 '-out', temp / 'synthetic.csr', '-subj', '/CN=Nanocodex Synthetic Signing Test/OU=SYNTHETIC1'])
        checked(['openssl', 'x509', '-req', '-in', temp / 'synthetic.csr', '-CA', ca_cert,
                 '-CAkey', ca_key, '-set_serial', '1', '-days', '1', '-out', cert])
        key.chmod(0o600)
        der = checked(['openssl', 'x509', '-in', cert, '-outform', 'DER'])
        (temp / 'main.c').write_text('int main(void) { return 0; }\n')
        checked([args.clang, '-target', 'arm64-apple-ios18.0', '-c', temp / 'main.c', '-o', temp / 'main.o'])
        checked([args.linker, '-arch', 'arm64', '-platform_version', 'ios', '18.0', '18.0',
                 '-e', '_main', temp / 'main.o', '-o', temp / 'main'])
        ids = ['xyz.paradigm.centaur', 'xyz.paradigm.centaur.share', 'xyz.paradigm.centaur.widgets']
        group = 'group.xyz.paradigm.centaur'
        profiles = []
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        for index, bundle in enumerate(ids):
            ent = {'application-identifier': 'SYNTHETIC1.' + bundle,
                   'com.apple.developer.team-identifier': 'SYNTHETIC1', 'get-task-allow': True}
            if index < 2:
                ent['com.apple.security.application-groups'] = [group]
            profiles.append({'UUID': 'synthetic-' + str(index), 'ApplicationIdentifierPrefix': ['SYNTHETIC1'],
                             'TeamIdentifier': ['SYNTHETIC1'], 'CreationDate': now - dt.timedelta(days=1),
                             'ExpirationDate': now + dt.timedelta(hours=1), 'Entitlements': ent,
                             'DeveloperCertificates': [der], 'ProvisionedDevices': ['SYNTHETIC-DEVICE']})

        def write_profile(index):
            source = temp / f'{index}.plist'
            source.write_bytes(plistlib.dumps(profiles[index]))
            checked(['openssl', 'cms', '-sign', '-binary', '-nodetach', '-in', source, '-signer', cert,
                     '-inkey', key, '-outform', 'DER', '-out', temp / f'{index}.mobileprovision'])

        for index in range(3):
            write_profile(index)
        ipa = temp / 'unsigned.ipa'

        def write_ipa(valid=True):
            with zipfile.ZipFile(ipa, 'w') as archive:
                for index, bundle in enumerate(ids):
                    folder = 'Payload/Nanocodex.app' + ('' if index == 0 else f'/PlugIns/Extension{index}.appex')
                    archive.writestr(folder + '/Info.plist', plistlib.dumps({'CFBundleIdentifier': bundle,
                        'CFBundleExecutable': 'main', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'}))
                    info = zipfile.ZipInfo(folder + '/main')
                    info.external_attr = 0o100755 << 16
                    archive.writestr(info, (temp / 'main').read_bytes() if valid else b'Invalid Mach-O')

        env = dict(os.environ, ZSIGN_PATH=str(args.zsign.resolve()), IOS_SIGNING_KEY=str(key),
                   IOS_SIGNING_CERT=str(cert), IOS_PROFILE_MAIN=str(temp / '0.mobileprovision'),
                   IOS_PROFILE_SHARE=str(temp / '1.mobileprovision'),
                   IOS_PROFILE_WIDGETS=str(temp / '2.mobileprovision'), IOS_DEVICE_UDID='')

        def journey(name, expected, override=None, success=False):
            output = temp / (name + '.ipa')
            result = command([ROOT / 'apple/scripts/sign-ios-linux.sh', ipa, output], env=env | (override or {}))
            message = (result.stdout + result.stderr).decode().replace(work, '$PRIVATE_TEST_DIR')
            trace.append(f'$ sign-ios-linux.sh unsigned.ipa {name}.ipa\nexit={result.returncode}\n' + message)
            assert (result.returncode == 0) == success, message
            assert expected in message, message
            if not success:
                assert not output.exists()
                assert not Path(str(output) + '.signing.json').exists()
            return output

        write_ipa()
        journey('missing-key', 'Set IOS_SIGNING_KEY', {'IOS_SIGNING_KEY': ''})
        key.chmod(0o644)
        journey('public-key-permissions', 'mode 0600 or 0400')
        key.chmod(0o600)
        journey('wrong-device', 'not provisioned', {'IOS_DEVICE_UDID': 'OTHER-SYNTHETIC-DEVICE'})
        profiles[1]['Entitlements']['com.apple.security.application-groups'] = []
        write_profile(1)
        journey('missing-share-group', 'must authorize App Group')
        profiles[1]['Entitlements']['com.apple.security.application-groups'] = [group]
        write_profile(1)
        profiles[2]['ExpirationDate'] = now - dt.timedelta(hours=1)
        write_profile(2)
        journey('expired-widget-profile', 'Expired or undated profile')
        profiles[2]['ExpirationDate'] = now + dt.timedelta(hours=1)
        profiles[2]['Entitlements']['application-identifier'] = 'SYNTHETIC1.*'
        write_profile(2)
        journey('wildcard-widget-profile', 'exact application-identifier')
        profiles[2]['Entitlements']['application-identifier'] = 'SYNTHETIC1.' + ids[2]
        write_profile(2)
        write_ipa(valid=False)
        journey('invalid-macho', 'zsign failed')
        write_ipa()
        output = journey('synthetic-signed', 'Apple device installation has not been verified.',
                         {'IOS_DEVICE_UDID': 'SYNTHETIC-DEVICE'}, success=True)
        report = json.loads(Path(str(output) + '.signing.json').read_text())
        assert [b['bundle_id'] for b in report['bundles']] == ids
        assert [b['app_groups'] for b in report['bundles']] == [[group], [group], []]
        assert report['apple_device_installation_verified'] is False and report['target_device_checked'] is True
        assert output.stat().st_mode & 0o777 == 0o600
        # Independently verify real CMS signatures over the on-disk CodeDirectory
        # with OpenSSL, using the synthetic leaf certificate instead of Apple trust.
        with zipfile.ZipFile(output) as archive:
            for name in archive.namelist():
                if not name.endswith('/main'):
                    continue
                binary = archive.read(name)
                cursor = 32
                for _ in range(struct.unpack_from('<I', binary, 16)[0]):
                    command_id, length = struct.unpack_from('<II', binary, cursor)
                    if command_id == 0x1d:
                        offset, size = struct.unpack_from('<II', binary, cursor + 8)
                        signature = binary[offset:offset + size]
                        break
                    cursor += length
                else:
                    raise AssertionError('Output executable has no signature')
                slots = {}
                for index in range(struct.unpack_from('>I', signature, 8)[0]):
                    kind, offset = struct.unpack_from('>II', signature, 12 + 8 * index)
                    size = struct.unpack_from('>I', signature, offset + 4)[0]
                    slots[kind] = signature[offset:offset + size]
                (temp / 'code-directory').write_bytes(slots[0])
                (temp / 'signature.der').write_bytes(slots[0x10000][8:])
                checked(['openssl', 'cms', '-verify', '-binary', '-inform', 'DER', '-in', temp / 'signature.der',
                         '-content', temp / 'code-directory', '-noverify', '-nointern', '-certfile', cert,
                         '-out', '/dev/null'])
        (args.output_dir / 'synthetic-report.json').write_text(json.dumps(report, indent=2) + '\n')
        before = output.read_bytes()
        result = command([ROOT / 'apple/scripts/sign-ios-linux.sh', ipa, output], env=env)
        assert result.returncode != 0 and b'Output already exists' in result.stderr
        assert output.read_bytes() == before
        trace.append('PASS: existing output rejected unchanged.\nPASS: real signing of three synthetic arm64 executables; '
                     'main/share groups retained, widgets isolated, all three CMS signatures verified by OpenSSL.\n'
                     'This is not signing of the Nanocodex app or Apple-device installation validation.\n')
finally:
    (args.output_dir / 'journeys.log').write_text('\n'.join(trace))
print('\n'.join(trace))
