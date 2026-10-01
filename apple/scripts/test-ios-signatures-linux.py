#!/usr/bin/env python3
"""Disposable real pinned-zsign integrity tests. No Apple secrets/network/install.

Creates unsigned minimal arm64 executables, a flat framework and dylib with the
SDK's iOS-capable ld64.lld, then signs them with a disposable synthetic identity.
Exercises SHA256-only and dual SHA1/SHA256, public certificate matching, CMS,
code/special/resource tampering and defensive parser limits. Keys, certificates,
profiles and IPAs are deleted; only sanitized evidence and JSON are persisted.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
REV = '614caa8d1ca949e260e5746144aa52d27a4b08d6'
spec = importlib.util.spec_from_file_location('signature_verifier', ROOT / 'apple/scripts/verify-ios-signatures-linux.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zsign', required=True, type=Path)
    parser.add_argument('--clang', default='clang')
    parser.add_argument('--linker', default='ld64.lld')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'output/ios-signature-verification')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    events = ['SYNTHETIC ONLY: no Apple identities, Apple trust, revocation or device-install evidence.']
    tests = []

    def passed(name):
        tests.append(name)
        events.append('PASS: ' + name)

    def rejects(name, fn, expected=None):
        try:
            fn()
        except (ValueError, struct.error, zipfile.BadZipFile) as e:
            if expected:
                assert expected in str(e), f'{name}: unexpected error {e}'
            passed(name)
        else:
            raise AssertionError('False success: ' + name)

    try:
        with tempfile.TemporaryDirectory(prefix='synthetic-ios-integrity-') as private:
            tmp = Path(private)
            (tmp / 'zsign-work').mkdir()
            def command(argv):
                result = subprocess.run(list(map(str, argv)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                events.append('$ ' + ' '.join(map(str, argv)).replace(private, '$PRIVATE_TEST_DIR') + f'\nexit={result.returncode}')
                assert result.returncode == 0, (result.stdout + result.stderr).decode().replace(private, '$PRIVATE_TEST_DIR')
                return result.stdout

            assert command([args.zsign, '--version']).decode().strip() == 'version: nanocodex-' + REV
            command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmp / 'ca-key.pem',
                     '-out', tmp / 'ca.pem', '-days', '1', '-subj',
                     '/CN=Apple Worldwide Developer Relations Certification Authority/OU=G3/O=Apple Inc./C=US'])
            for name in ('leaf', 'wrong'):
                command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmp / (name + '-key.pem'),
                         '-out', tmp / (name + '.csr'), '-subj', '/CN=Nanocodex Synthetic Integrity Test/OU=SYNTHETIC1'])
                # Identical issuer/serial, DIFFERENT key: expected fingerprint must
                # match actual verified signer, not a certificate bag or DN.
                command(['openssl', 'x509', '-req', '-in', tmp / (name + '.csr'), '-CA', tmp / 'ca.pem',
                         '-CAkey', tmp / 'ca-key.pem', '-set_serial', '1', '-days', '1', '-out', tmp / (name + '.pem')])
            cert_der = command(['openssl', 'x509', '-in', tmp / 'leaf.pem', '-outform', 'DER'])
            (tmp / 'leaf.der').write_bytes(cert_der)
            (tmp / 'critical.cnf').write_text('1.2.3.4=critical,DER:01:01:FF\n')
            command(['openssl', 'x509', '-req', '-in', tmp / 'leaf.csr', '-CA', tmp / 'ca.pem',
                     '-CAkey', tmp / 'ca-key.pem', '-set_serial', '2', '-days', '1',
                     '-extfile', tmp / 'critical.cnf', '-out', tmp / 'critical.pem'])
            critical_der = v.certificate_der(tmp / 'critical.pem')
            now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
            for i, bid in enumerate(v.IDS):
                ent = {'application-identifier': 'SYNTHETIC1.' + bid,
                       'com.apple.developer.team-identifier': 'SYNTHETIC1', 'get-task-allow': True}
                if i < 2:
                    ent['com.apple.security.application-groups'] = ['group.xyz.paradigm.centaur']
                profile = {'UUID': 'synthetic-integrity-' + str(i), 'ApplicationIdentifierPrefix': ['SYNTHETIC1'],
                           'TeamIdentifier': ['SYNTHETIC1'], 'CreationDate': now - dt.timedelta(days=1),
                           'ExpirationDate': now + dt.timedelta(hours=1), 'Entitlements': ent,
                           'DeveloperCertificates': [cert_der], 'ProvisionedDevices': ['SYNTHETIC-NOT-A-DEVICE']}
                (tmp / f'{i}.plist').write_bytes(plistlib.dumps(profile))
                command(['openssl', 'cms', '-sign', '-binary', '-nodetach', '-in', tmp / f'{i}.plist',
                         '-signer', tmp / 'leaf.pem', '-inkey', tmp / 'leaf-key.pem', '-outform', 'DER',
                         '-out', tmp / f'{i}.mobileprovision'])
            (tmp / 'main.c').write_text('int main(void) { return 0; }\n')
            (tmp / 'library.c').write_text('int synthetic_function(void) { return 42; }\n')
            for base in ('main', 'library'):
                command([args.clang, '-target', 'arm64-apple-ios18.0', '-c', tmp / (base + '.c'), '-o', tmp / (base + '.o')])
            command([args.linker, '-arch', 'arm64', '-platform_version', 'ios', '18.0', '18.0', '-no_adhoc_codesign',
                     '-e', '_main', tmp / 'main.o', '-o', tmp / 'main'])
            command([args.linker, '-arch', 'arm64', '-platform_version', 'ios', '18.0', '18.0', '-no_adhoc_codesign',
                     '-dylib', '-install_name', '@rpath/Synthetic.framework/Synthetic', tmp / 'library.o', '-o', tmp / 'library'])
            def unsigned(binary):
                count = struct.unpack_from('<I', binary, 16)[0]
                pos = 32
                for _ in range(count):
                    kind, size = struct.unpack_from('<II', binary, pos)
                    assert kind != 0x1d, 'Fixture must start genuinely unsigned'
                    pos += size
            unsigned((tmp / 'main').read_bytes())
            unsigned((tmp / 'library').read_bytes())
            passed('SDK-linked thin arm64 fixtures are unsigned before zsign')
            folders = ['Payload/Nanocodex.app', 'Payload/Nanocodex.app/PlugIns/Share.appex',
                       'Payload/Nanocodex.app/PlugIns/Widgets.appex']
            framework = folders[0] + '/Frameworks/Synthetic.framework'
            entries = {}
            for folder, bid in zip(folders, v.IDS):
                entries[folder + '/Info.plist'] = plistlib.dumps({'CFBundleIdentifier': bid, 'CFBundleExecutable': 'main',
                    'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.0'})
                entries[folder + '/main'] = (tmp / 'main').read_bytes()
                entries[folder + '/resource.txt'] = b'Synthetic resource integrity fixture\n'
                entries[folder + '/Base.lproj/message.txt'] = b'localization integrity fixture'
                entries[folder + '/Base.lproj/locversion.plist'] = b'omitted zsign resource'
            entries[framework + '/Info.plist'] = plistlib.dumps({'CFBundleIdentifier': 'test.synthetic.framework',
                                                               'CFBundleExecutable': 'Synthetic'})
            entries[framework + '/Synthetic'] = (tmp / 'library').read_bytes()
            entries[framework + '/resource.txt'] = b'framework sealed resource'
            dylib = folders[0] + '/Frameworks/libSynthetic.dylib'
            entries[dylib] = (tmp / 'library').read_bytes()
            def write_zip(path, values):
                with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                    for name, value in values.items():
                        item = zipfile.ZipInfo(name)
                        item.external_attr = (0o100755 if name.endswith(('/main', '/Synthetic', '.dylib')) else 0o100644) << 16
                        archive.writestr(item, value)
            write_zip(tmp / 'unsigned.ipa', entries)
            reports = []
            for mode, flags in [('sha256', []), ('dual', ['-L'])]:
                target = tmp / (mode + '.ipa')
                argv = [args.zsign, '-q', '-f', '-z', '9', '-k', tmp / 'leaf-key.pem', '-c', tmp / 'leaf.pem'] + flags
                for i in range(3):
                    argv += ['-m', tmp / f'{i}.mobileprovision']
                command(argv + ['-t', tmp / 'zsign-work', '-o', target, tmp / 'unsigned.ipa'])
                report = v.verify_ipa(target, tmp / 'leaf.pem')
                assert len(report['code_objects']) == 5
                assert all(len(x['code_directories']) == (1 if mode == 'sha256' else 2) for x in report['code_objects'])
                assert report['caller_ca_chain_verified'] is False and report['built_in_apple_trust_verified'] is False
                reports.append(report)
                passed(mode + ': three bundles + framework + dylib CMS/code/special/resource verification')
                assert v.verify_ipa(target, tmp / 'leaf.der')['signer_sha256'] == report['signer_sha256']
                passed(mode + ': DER expected public certificate accepted')
                rejects(mode + ': wrong public certificate with identical issuer/serial rejected',
                        lambda: v.verify_ipa(target, tmp / 'wrong.pem'), 'Actual CMS signer')
                rejects(mode + ': synthetic leaf is not trusted by unrelated CA',
                        lambda: v.verify_ipa(target, tmp / 'leaf.pem', tmp / 'wrong.pem'), 'OpenSSL')
                # zsign embeds Apple's PUBLIC CA chain, not our disposable CA.
                # Explicit supplied synthetic CA still verifies leaf->CA path.
                trusted = v.verify_ipa(target, tmp / 'leaf.pem', tmp / 'ca.pem')
                assert trusted['caller_ca_chain_verified'] and not trusted['built_in_apple_trust_verified']
                passed(mode + ': caller synthetic CA verifies only caller trust, not Apple trust')
                trust_dir = tmp / 'default-trust'
                trust_dir.mkdir(exist_ok=True)
                (trust_dir / 'ca.pem').write_bytes((tmp / 'ca.pem').read_bytes())
                command(['openssl', 'rehash', trust_dir])
                previous = os.environ.get('SSL_CERT_DIR')
                try:
                    os.environ['SSL_CERT_DIR'] = str(trust_dir)
                    rejects(mode + ': caller CA excludes ambient SSL_CERT_DIR trust',
                            lambda: v.verify_ipa(target, tmp / 'leaf.pem', tmp / 'wrong.pem'), 'OpenSSL')
                finally:
                    if previous is None:
                        os.environ.pop('SSL_CERT_DIR', None)
                    else:
                        os.environ['SSL_CERT_DIR'] = previous

                with zipfile.ZipFile(target) as archive:
                    signed = {n: archive.read(n) for n in archive.namelist() if not n.endswith('/')}
                main_name = folders[0] + '/main'
                binary = signed[main_name]
                limit, _, slots = v.macho_signature(binary)
                resource = signed[folders[0] + '/_CodeSignature/CodeResources']
                info = signed[folders[0] + '/Info.plist']
                def binary_check(data):
                    return v.verify_binary(data, cert_der, info, resource, v.IDS[0], bundle=True)
                directories = [slots[k] for k in sorted(k for k in slots if k == 0 or 0x1000 <= k <= 0x1005)]
                summaries = binary_check(binary)['code_directories']
                cms = slots[0x10000][8:]
                root = v.der_node(cms)
                ber_cms = b'\x30\x80' + cms[root[1]:root[2]] + b'\0\0'
                assert v.verify_cms(ber_cms, directories, summaries, cert_der) == hashlib.sha256(cert_der).hexdigest()
                passed(mode + ': indefinite BER CMS independently verified and authenticated attrs normalized')
                rejects(mode + ': truncated indefinite BER CMS', lambda: v.verify_cms(ber_cms[:-1], directories, summaries, cert_der), 'Truncated')
                rejects(mode + ': trailing CMS payload', lambda: v.verify_cms(cms + b'unsigned', directories, summaries, cert_der), 'framing/trailing')
                (tmp / 'primary.cd').write_bytes(directories[0])
                command(['openssl', 'cms', '-sign', '-binary', '-in', tmp / 'primary.cd', '-signer', tmp / 'leaf.pem',
                         '-inkey', tmp / 'leaf-key.pem', '-outform', 'DER', '-out', tmp / 'no-agility.cms'])
                command(['openssl', 'cms', '-sign', '-binary', '-in', tmp / 'primary.cd',
                         '-signer', tmp / 'critical.pem', '-inkey', tmp / 'leaf-key.pem',
                         '-outform', 'DER', '-out', tmp / 'critical.cms'])
                rejects(mode + ': caller CA rejects unknown critical extension without bypass', lambda:
                    v.verify_cms((tmp / 'critical.cms').read_bytes(), directories, summaries,
                                 critical_der, tmp / 'ca.pem'), 'unhandled critical certificate extension')
                rejects(mode + ': valid CMS without authenticated CodeDirectory attrs', lambda:
                    v.verify_cms((tmp / 'no-agility.cms').read_bytes(), directories, summaries, cert_der), 'cdhashes attribute missing')
                command(['openssl', 'cms', '-sign', '-binary', '-nodetach', '-in', tmp / 'primary.cd', '-signer', tmp / 'leaf.pem',
                         '-inkey', tmp / 'leaf-key.pem', '-outform', 'DER', '-out', tmp / 'attached.cms'])
                rejects(mode + ': attached CMS rejected', lambda:
                    v.verify_cms((tmp / 'attached.cms').read_bytes(), directories, summaries, cert_der), 'detached')
                def flip(data, offset):
                    result = bytearray(data)
                    result[offset] ^= 1
                    return bytes(result)
                def slot_location(kind):
                    sig = binary[limit:]
                    for j in range(v.be32(sig, 8)):
                        k, pos = struct.unpack_from('>II', sig, 12 + j * 8)
                        if k == kind:
                            return limit + pos
                    raise AssertionError('fixture missing slot')
                # Signed load commands may not point into mutable signature
                # allocation bytes. Check range enforcement before page hashing.
                pos = 32
                command_positions, section_positions = {}, []
                for _ in range(struct.unpack_from('<I', binary, 16)[0]):
                    cmd, size = struct.unpack_from('<II', binary, pos)
                    command_positions[cmd] = pos
                    if cmd == 0x19:
                        section_positions.extend(pos + 72 + j * 80
                            for j in range(struct.unpack_from('<I', binary, pos + 64)[0]))
                    pos += size
                for cmd, label in ((0x26, 'function starts'), (0x29, 'data in code'),
                                   (0x80000033, 'export trie'), (0x80000034, 'chained fixups')):
                    assert cmd in command_positions, 'SDK fixture load command missing'
                    changed = bytearray(binary)
                    struct.pack_into('<II', changed, command_positions[cmd] + 8, len(binary) - 1, 1)
                    rejects(mode + ': unsigned ' + label + ' metadata',
                            lambda changed=changed: binary_check(bytes(changed)), 'Unsigned Mach-O loader')
                changed = bytearray(binary)
                struct.pack_into('<II', changed, command_positions[0x2] + 16, len(binary) - 1, 1)
                rejects(mode + ': unsigned symbol string table', lambda: binary_check(bytes(changed)), 'Unsigned Mach-O loader')
                changed = bytearray(binary)
                struct.pack_into('<II', changed, command_positions[0xb] + 56, len(binary) - 4, 1)
                rejects(mode + ': unsigned indirect symbol table', lambda: binary_check(bytes(changed)), 'Unsigned Mach-O loader')
                assert section_positions, 'SDK section fixture missing'
                changed = bytearray(binary)
                struct.pack_into('<II', changed, section_positions[0] + 56, len(binary) - 8, 1)
                rejects(mode + ': unsigned section relocation table', lambda: binary_check(bytes(changed)), 'Unsigned Mach-O loader')
                # Legacy dyld-info command is 48 bytes; repurpose enough space
                # in the first segment command without changing overall framing.
                # Constructing a minimal parser fixture avoids SDK-version
                # dependence on classic rather than chained-fixup dyld metadata.
                def legacy_dyld_fixture(dataoff, datasize):
                    limit = 4096
                    sig = struct.pack('>7I', 0xfade0cc0, 28, 1, 2, 20, 0xfade0c01, 8)
                    segment = struct.pack('<II16sQQQQIIII', 0x19, 72, b'__LINKEDIT',
                                          0, limit + len(sig), 0, limit + len(sig), 1, 1, 0, 0)
                    dyld = struct.pack('<12I', 0x80000022, 48, dataoff, datasize, *([0] * 8))
                    cmds = segment + dyld + struct.pack('<4I', 0x1d, 16, limit, len(sig))
                    header = struct.pack('<8I', 0xfeedfacf, 0x100000c, 0, 2, 3, len(cmds), 0, 0)
                    return (header + cmds).ljust(limit, b'\0') + sig
                assert v.macho_signature(legacy_dyld_fixture(4095, 1))[0] == 4096
                rejects(mode + ': unsigned classic dyld rebase metadata',
                        lambda: v.macho_signature(legacy_dyld_fixture(4096, 1)), 'Unsigned Mach-O loader')
                # End-to-end: self-sign the adversarial command with a NEW
                # synthetic signature so rejection is not merely a code-page
                # mismatch. Before hardening, tail mutation also passed CMS.
                changed = bytearray(binary)
                struct.pack_into('<II', changed, command_positions[0x26] + 8, len(binary) - 1, 1)
                candidate = dict(signed)
                candidate[main_name] = bytes(changed)
                write_zip(tmp / 'loader-input.ipa', candidate)
                command(argv + ['-t', tmp / 'zsign-work', '-o', tmp / 'loader-signed.ipa', tmp / 'loader-input.ipa'])
                rejects(mode + ': CMS-signed command referencing unsigned padding',
                        lambda: v.verify_ipa(tmp / 'loader-signed.ipa', tmp / 'leaf.pem'), 'Unsigned Mach-O loader')
                rejects(mode + ': executable page mutation', lambda: binary_check(flip(binary, 4096)), 'Code page')
                rejects(mode + ': CMS cryptographic mutation', lambda: binary_check(flip(binary, slot_location(0x10000) + len(slots[0x10000]) - 1)), 'OpenSSL')
                for kind, label in ((2, 'requirements'), (5, 'XML entitlements'), (7, 'DER entitlements')):
                    rejects(mode + ': ' + label + ' authenticated special slot mutation',
                            lambda kind=kind: binary_check(flip(binary, slot_location(kind) + len(slots[kind]) - 1)))
                rejects(mode + ': Info.plist authenticated special slot mutation',
                        lambda: v.verify_binary(binary, cert_der, info + b' ', resource, v.IDS[0], bundle=True), 'Special slot 1')
                rejects(mode + ': CodeResources authenticated special slot mutation',
                        lambda: v.verify_binary(binary, cert_der, info, resource + b' ', v.IDS[0], bundle=True), 'Special slot 3')
                rejects(mode + ': CodeDirectory page hash mutation', lambda: binary_check(flip(binary,
                    slot_location(0) + v.be32(slots[0], 16))), 'Code page')
                rejects(mode + ': appended unsealed bytes', lambda: binary_check(binary + b'unsigned'), 'EOF')
                padding_result = binary_check(flip(binary, len(binary) - 1))
                assert padding_result['unauthenticated_signature_allocation_padding_bytes'] > 0
                passed(mode + ': signature allocation padding explicitly disclosed as unauthenticated')
                if mode == 'dual':
                    # Both directories remain internally correct, but swapping
                    # their serialized roles breaks CMS(primary) verification.
                    rejects('dual: alternate hash mutation', lambda: binary_check(flip(binary,
                        slot_location(0x1000) + v.be32(slots[0x1000], 16))), 'Code page')
                    summaries = [v.code_directory(slots[k], binary, limit, {1: info, 2: slots[2], 3: resource,
                                 5: slots[5], 7: slots[7]}) for k in (0, 0x1000)]
                    # A replacement alternate, with its own valid metadata/pages,
                    # must be rejected by the AUTHENTICATED alternate hash attr.
                    changed_cd = bytearray(slots[0x1000])
                    struct.pack_into('>I', changed_cd, 12, 0x10000)  # flags, leaves pages/specials valid
                    changed_summary = v.code_directory(bytes(changed_cd), binary, limit,
                        {1: info, 2: slots[2], 3: resource, 5: slots[5], 7: slots[7]})
                    rejects('dual: internally valid alternate not bound by CMS rejected', lambda:
                        v.verify_cms(slots[0x10000][8:], [slots[0], bytes(changed_cd)],
                                     [summaries[0], changed_summary], cert_der), 'CMS cdhashes')
                # Independent resources: verify each file and both hash tables,
                # not only parent seal presence; signed CMS cannot be rebuilt by
                # an attacker, but direct calls pinpoint hash/table enforcement.
                def resources_case(label, mutate, expected=None):
                    changed = dict(signed)
                    mutate(changed)
                    write_zip(tmp / 'bad.ipa', changed)
                    bad = v.IPA(tmp / 'bad.ipa')
                    try:
                        rejects(mode + ': resource ' + label, lambda: v.verify_resources(bad, folders[0], 'main'), expected)
                    finally:
                        bad.archive.close()
                resources_case('file mutation', lambda x: x.__setitem__(folders[0] + '/resource.txt', b'tamper'), 'Resource hash')
                # Signed omission rules may not authorize new gaps. The fixed
                # locversion allowlist remains supported but must be disclosed.
                changed = dict(signed)
                locversion = 'Base.lproj/locversion.plist'
                changed[folders[0] + '/' + locversion] = b'changed unauthenticated localization version'
                write_zip(tmp / 'omitted.ipa', changed)
                omission_report = v.verify_ipa(tmp / 'omitted.ipa', tmp / 'leaf.pem')
                main_report = next(o for o in omission_report['code_objects'] if o.get('bundle_id') == v.IDS[0])
                assert locversion in main_report['resources']['unauthenticated_resource_paths']
                assert all(locversion in x for x in main_report['resources']['table_omissions'].values())
                passed(mode + ': omitted locversion bytes explicitly disclosed, not integrity-proven')
                resources_case('new unsealed file', lambda x: x.__setitem__(folders[0] + '/new.txt', b'unsealed'), 'Unsealed resource')
                resources_case('missing optional localization', lambda x: x.pop(folders[0] + '/Base.lproj/message.txt'), 'missing')
                resources_case('nested framework resource mutation', lambda x: x.__setitem__(framework + '/resource.txt', b'tamper'), 'Resource hash')
                def change_seal(values, field, fn):
                    key = folders[0] + '/_CodeSignature/CodeResources'
                    res = plistlib.loads(values[key])
                    fn(res[field])
                    values[key] = plistlib.dumps(res)
                for table in ('files', 'files2'):
                    resources_case(table + ' digest mutation', lambda x, table=table: change_seal(x, table,
                        lambda t: t.__setitem__('resource.txt', {'hash': b'0' * 20, 'hash2': b'0' * 32})), 'Resource hash')
                resources_case('unsupported nested cdhash seal', lambda x: change_seal(x, 'files2',
                    lambda t: t.__setitem__('resource.txt', {'cdhash': b'0' * 20, 'requirement': 'true'})), 'Unsupported resource seal')
                resources_case('missing SHA256 files2 hash', lambda x: change_seal(x, 'files2',
                    lambda t: t['resource.txt'].pop('hash2')), 'hashes missing')
                def arbitrary_omit(values):
                    key = folders[0] + '/_CodeSignature/CodeResources'
                    res = plistlib.loads(values[key])
                    for table in ('files', 'files2'):
                        res[table].pop('resource.txt')
                    for rules in ('rules', 'rules2'):
                        res[rules]['^resource\\.txt$'] = {'omit': True, 'weight': 999999}
                    values[key] = plistlib.dumps(res)
                resources_case('arbitrary signed omission rule cannot expand allowlist',
                               arbitrary_omit, 'Unsealed resource')
                resources_case('unsafe seal path', lambda x: change_seal(x, 'files2',
                    lambda t: t.__setitem__('../escape', {'hash': b'0' * 20, 'hash2': b'0' * 32})), 'path')
                # Container structural mutations fail before OpenSSL invocation.
                rejects(mode + ': fat Mach-O rejected', lambda: binary_check(b'\xca\xfe\xba\xbe' + binary[4:]), 'Unsupported Mach-O')
                rejects(mode + ': truncated Mach-O rejected', lambda: binary_check(binary[:20]), 'Unsupported Mach-O')
                changed = bytearray(binary)
                struct.pack_into('<I', changed, 16, 0xffffffff)
                rejects(mode + ': excessive load command count', lambda: binary_check(bytes(changed)), 'load-command')
                changed = bytearray(binary)
                struct.pack_into('>I', changed, limit + 8, 0xffffffff)
                rejects(mode + ': excessive signature slot count', lambda: binary_check(bytes(changed)), 'superblob')
                changed = bytearray(binary)
                struct.pack_into('>I', changed, limit + 20, v.be32(changed, limit + 12))
                rejects(mode + ': duplicate signature slot', lambda: binary_check(bytes(changed)), 'slot')
                rejects(mode + ': truncated DER CMS', lambda: v.cms_attributes(slots[0x10000][8:-1]), 'Truncated DER')
                changed = bytearray(slots[0])
                struct.pack_into('>I', changed, 8, 0x20600)
                rejects(mode + ': future CodeDirectory unsupported', lambda: v.code_directory(bytes(changed), binary, limit, {}), 'Unsupported')
                changed = bytearray(slots[0])
                changed[37] = 4
                rejects(mode + ': unsupported hash type', lambda: v.code_directory(bytes(changed), binary, limit, {}), 'Unsupported')
                changed = bytearray(slots[0])
                struct.pack_into('>I', changed, 44, 88)
                rejects(mode + ': scatter CodeDirectory unsupported', lambda: v.code_directory(bytes(changed), binary, limit, {}), 'Scatter')
                # Explicit directories must not hide beneath a regular file.
                with zipfile.ZipFile(tmp / 'collision.ipa', 'w') as z:
                    z.writestr('Payload/file', b'sealed-like regular file')
                    z.writestr('Payload/file/subdirectory/', b'')
                rejects(mode + ': explicit directory below regular file rejected',
                        lambda: v.IPA(tmp / 'collision.ipa'), 'collision')
                with zipfile.ZipFile(tmp / 'wrong-directory-mode.ipa', 'w') as z:
                    e = zipfile.ZipInfo('Payload/directory/')
                    e.external_attr = 0o100644 << 16
                    z.writestr(e, b'')
                rejects(mode + ': regular-file mode on directory rejected',
                        lambda: v.IPA(tmp / 'wrong-directory-mode.ipa'), 'directory mode')
                # ZipInfo silently truncates embedded NUL on read. Patch both
                # header copies, retaining equal-length names, to exercise input.
                write_zip(tmp / 'nul.ipa', {'Payload/fileXname': b'content'})
                (tmp / 'nul.ipa').write_bytes((tmp / 'nul.ipa').read_bytes().replace(
                    b'Payload/fileXname', b'Payload/file\x00name'))
                rejects(mode + ': NUL-truncated ZIP path rejected',
                        lambda: v.IPA(tmp / 'nul.ipa'), 'NUL archive path')
                # Full archive attacks; no shell extraction is ever used.
                write_zip(tmp / 'bad.ipa', dict(signed, **{'../escape': b'bad'}))
                rejects(mode + ': archive traversal rejected', lambda: v.verify_ipa(tmp / 'bad.ipa', tmp / 'leaf.pem'), 'path')
                with zipfile.ZipFile(tmp / 'link.ipa', 'w') as z:
                    e = zipfile.ZipInfo('Payload/link')
                    e.external_attr = 0o120777 << 16
                    z.writestr(e, b'../../escape')
                rejects(mode + ': archive symlink rejected', lambda: v.IPA(tmp / 'link.ipa'), 'link/type')
                # Exercise production CLI success/new report/exclusive output.
                report_file = tmp / (mode + '.json')
                command(['python3', ROOT / 'apple/scripts/verify-ios-signatures-linux.py', target,
                         '--expected-certificate', tmp / 'leaf.pem', '--output', report_file])
                cli_report = json.loads(report_file.read_text())
                assert cli_report == report
                result = subprocess.run(['python3', str(ROOT / 'apple/scripts/verify-ios-signatures-linux.py'), str(target),
                    '--expected-certificate', str(tmp / 'leaf.pem'), '--output', str(report_file)], capture_output=True)
                assert result.returncode != 0 and json.loads(report_file.read_text()) == report
                passed(mode + ': CLI success and immutable report overwrite rejection')
            (args.output_dir / 'synthetic-reports.json').write_text(json.dumps(reports, indent=2) + '\n')
            (args.output_dir / 'result.json').write_text(json.dumps({'status': 'passed', 'tests': tests,
                'test_count': len(tests), 'zsign_revision': REV, 'synthetic_only': True,
                'apple_trust_revocation_or_device_proof': False}, indent=2) + '\n')
    finally:
        (args.output_dir / 'journeys.log').write_text('\n'.join(events) + '\n')
    print('\n'.join(events))


if __name__ == '__main__':
    main()
