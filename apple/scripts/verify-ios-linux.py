#!/usr/bin/env python3
"""Check the actual IPA's device binaries. Does not claim runtime/Apple trust."""
import argparse
import json
import plistlib
import struct
import zipfile
from pathlib import PurePosixPath


def macho(data):
    magic, cpu, _, kind, count, size, _, _ = struct.unpack_from('<8I', data)
    assert magic == 0xfeedfacf and cpu == 0x100000c, 'Expected thin arm64 Mach-O'
    assert 32 + size <= len(data), 'Truncated load commands'
    offset, text_bytes, text_base, entry, symtab = 32, 0, None, None, None
    signature = False
    for _ in range(count):
        command, length = struct.unpack_from('<II', data, offset)
        assert length >= 8 and offset + length <= 32 + size, 'Invalid load command'
        if command == 0x19:
            segment = data[offset+8:offset+24].rstrip(b'\0')
            if segment == b'__TEXT':
                text_base = struct.unpack_from('<Q', data, offset+24)[0]
            for i in range(struct.unpack_from('<I', data, offset+64)[0]):
                section = offset+72+80*i
                assert section + 80 <= offset+length, 'Invalid section table'
                if data[section:section+16].rstrip(b'\0') == b'__text':
                    text_bytes += struct.unpack_from('<Q', data, section+40)[0]
        elif command == 0x80000028:
            entry = struct.unpack_from('<Q', data, offset+8)[0]
        elif command == 2:
            symtab = struct.unpack_from('<4I', data, offset+8)
        elif command == 0x1d:
            start, length_sig = struct.unpack_from('<II', data, offset+8)
            signature = length_sig > 0 and start + length_sig <= len(data)
        offset += length
    assert text_bytes > 0, 'Executable has no code: extension may have linked only a stub'
    symbols = {}
    if symtab:
        start, count, strings, string_size = symtab
        assert start + count*16 <= len(data) and strings + string_size <= len(data)
        for i in range(count):
            index, typ, section, _, value = struct.unpack_from('<IBBHQ', data, start+16*i)
            if section and (typ & 0x0e) == 0x0e and index < string_size:
                end = data.find(b'\0', strings+index, strings+string_size)
                assert end >= 0
                symbols[data[strings+index:end].decode(errors='replace')] = value
    return dict(kind=kind, code_bytes=text_bytes, signature_present=signature,
                entry=entry, text_base=text_base, symbols=symbols)


def verify(path):
    reports = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        roots = [n for n in names if n.startswith('Payload/') and n.endswith('.app/Info.plist') and n.count('/') == 2]
        assert len(roots) == 1, 'Expected one app'
        root = str(PurePosixPath(roots[0]).parent)
        infos = [roots[0]] + sorted(n for n in names if n.startswith(root+'/PlugIns/') and n.endswith('.appex/Info.plist') and n.count('/') == 4)
        assert len(infos) == 3, 'Expected app, share extension, and widgets'
        for name in infos:
            info = plistlib.loads(archive.read(name))
            binary = str(PurePosixPath(name).parent / info['CFBundleExecutable'])
            result = macho(archive.read(binary))
            assert result['kind'] == 2 and result['signature_present'], 'Expected signed executable structure'
            extension = info.get('NSExtension', {})
            principal = extension.get('NSExtensionPrincipalClass')
            if principal:
                cls = principal.rsplit('.', 1)[-1]
                assert any('OBJC_CLASS' in s and cls in s for s in result['symbols']), 'Missing extension principal class'
            if extension.get('NSExtensionPointIdentifier') == 'com.apple.widgetkit-extension':
                assert result['symbols'].get('_main') is not None, 'Missing WidgetBundle main'
                assert result['entry'] + result['text_base'] == result['symbols']['_main'], 'Widget entry does not run its Swift main'
            reports.append(dict(bundle_id=info['CFBundleIdentifier'], executable=binary,
                                code_bytes=result['code_bytes'], signature_present=result['signature_present']))
        assert {r['bundle_id'] for r in reports} == {'xyz.paradigm.centaur', 'xyz.paradigm.centaur.share', 'xyz.paradigm.centaur.widgets'}
        framework = macho(archive.read(root+'/Frameworks/WebRTC.framework/WebRTC'))
        assert framework['kind'] == 6, 'Missing device WebRTC dylib'
    return dict(bundles=reports, webrtc_arm64=True, apple_trust_verified=False, device_installation_verified=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.ipa), indent=2))
    except (AssertionError, KeyError, ValueError, struct.error, zipfile.BadZipFile) as error:
        parser.exit(1, f'verify-ios-linux: {error}\n')
