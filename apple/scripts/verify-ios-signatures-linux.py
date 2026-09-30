#!/usr/bin/env python3
"""Offline, independent integrity verification of pinned zsign thin-arm64 IPAs.

Requires Python 3 and OpenSSL. Reads no signing keys or network services;
profile bytes are resource-hashed, never decoded or reported. --expected-certificate is mandatory (PEM or DER public cert).
Checks detached CMS with OpenSSL, the actual signer certificate, authenticated
CodeDirectories (including alternates), every code page, special-slot hashes,
and flat files/files2 resource seals. Allowlisted omissions are disclosed, not
authenticated; ZIP metadata/permissions are not code-signature-bound. Supports one app and two direct extensions,
flat iOS frameworks and dylibs, not universal binaries, scatter/pre-encrypt CDs,
Apple nested cdhash/symlink resource seals or requirement-expression evaluation.
Unsupported formats fail closed. Limits: no Apple policy, provisioning/device,
revocation, timestamp, notarization or install verification. Without --ca-file,
-noverify disables certificate-chain validation ONLY, not CMS cryptography. With
--ca-file, OpenSSL checks an explicitly supplied trust store with purpose=any;
this is caller trust, not built-in Apple trust or Apple code-signing policy.
OpenSSL may reject Apple-specific critical extensions; these are never ignored.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

IDS = ('xyz.paradigm.centaur', 'xyz.paradigm.centaur.share', 'xyz.paradigm.centaur.widgets')
MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_SIGNATURE = 16 * 1024 * 1024
MACH_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
               b'\xfe\xed\xfa\xce', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
               b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def be32(data, offset):
    require(0 <= offset <= len(data) - 4, 'Truncated uint32')
    return struct.unpack_from('>I', data, offset)[0]


def path_name(name):
    require(isinstance(name, str) and name and '\\' not in name and '\x00' not in name,
            'Unsafe resource/archive path')
    p = PurePosixPath(name)
    require(not p.is_absolute() and not any(x in ('', '.', '..') for x in name.split('/'))
            and str(p) == name, 'Noncanonical resource/archive path')
    return name


def plist(data):
    require(len(data) <= MAX_SIGNATURE, 'Oversized plist')
    try:
        result = plistlib.loads(data)
    except Exception as e:
        raise ValueError('Malformed plist') from e
    require(isinstance(result, dict), 'Expected plist dictionary')
    return result


def openssl(argv, data=None):
    result = subprocess.run(['openssl'] + list(map(str, argv)), input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    # Do not echo certificate subjects or provisioning contents from diagnostics.
    reason = ' (unhandled critical certificate extension; Apple policy unsupported)' if b'unhandled critical extension' in result.stderr else ''
    require(result.returncode == 0, 'OpenSSL verification/decoding failed' + reason)
    return result.stdout


def certificate_der(path):
    data = Path(path).read_bytes()
    require(len(data) <= MAX_SIGNATURE, 'Oversized certificate')
    fmt = 'PEM' if data.startswith(b'-----BEGIN CERTIFICATE-----') else 'DER'
    if fmt == 'PEM':
        require(data.count(b'-----BEGIN CERTIFICATE-----') == 1, 'Expected exactly one certificate')
    return openssl(['x509', '-inform', fmt, '-outform', 'DER'], data)


# Strict definite-length DER parser, used ONLY to locate authenticated CMS
# attributes and enforce detached single-signer structure. OpenSSL does all CMS
# signature/digest/public-key cryptography; no custom signature implementation.
def der_node(data, pos=0, end=None):
    end = len(data) if end is None else end
    require(0 <= pos < end <= len(data), 'Truncated DER')
    start, tag = pos, data[pos]
    pos += 1
    require(tag & 31 != 31 and pos < end, 'Unsupported DER tag')
    size = data[pos]
    pos += 1
    if size & 128:
        n = size & 127
        require(1 <= n <= 4 and pos + n <= end and data[pos] != 0, 'Invalid DER length')
        size = int.from_bytes(data[pos:pos + n], 'big')
        require(size >= 128, 'Nonminimal DER length')
        pos += n
    require(pos + size <= end, 'Truncated DER value')
    return (tag, pos, pos + size, start)


def der_children(data, node):
    result, pos = [], node[1]
    while pos < node[2]:
        require(len(result) < 4096, 'Too many DER elements')
        child = der_node(data, pos, node[2])
        result.append(child)
        pos = child[2]
    return result


def der_value(data, node, tag):
    require(node[0] == tag, 'Unexpected DER type')
    return data[node[1]:node[2]]


def cms_attributes(data):
    require(len(data) <= MAX_SIGNATURE, 'Oversized CMS')
    root = der_node(data)
    require(root[0] == 0x30 and root[2] == len(data), 'Invalid CMS root')
    content = der_children(data, root)
    require(len(content) == 2 and der_value(data, content[0], 6) == bytes.fromhex('2a864886f70d010702')
            and content[1][0] == 0xa0, 'CMS is not SignedData')
    inner = der_children(data, content[1])
    require(len(inner) == 1 and inner[0][0] == 0x30, 'Invalid SignedData')
    sd = der_children(data, inner[0])
    require(4 <= len(sd) <= 6 and sd[0][0] == 2 and sd[1][0] == 0x31 and sd[2][0] == 0x30
            and sd[-1][0] == 0x31, 'Invalid SignedData fields')
    encap = der_children(data, sd[2])
    require(len(encap) == 1 and der_value(data, encap[0], 6) == bytes.fromhex('2a864886f70d010701'),
            'CMS must be detached data')
    signers = der_children(data, sd[-1])
    require(len(signers) == 1 and signers[0][0] == 0x30, 'Expected exactly one CMS signer')
    signer = der_children(data, signers[0])
    require(len(signer) in (6, 7) and signer[3][0] == 0xa0, 'CMS signed attributes required')
    attributes = {}
    for attr in der_children(data, signer[3]):
        require(attr[0] == 0x30, 'Malformed CMS attribute')
        fields = der_children(data, attr)
        require(len(fields) == 2 and fields[1][0] == 0x31, 'Malformed CMS attribute fields')
        oid = der_value(data, fields[0], 6).hex()
        require(oid not in attributes, 'Duplicate CMS signed attribute')
        attributes[oid] = der_children(data, fields[1])
    return attributes


def superblob(data, magic, max_count=32):
    require(12 <= len(data) <= MAX_SIGNATURE and be32(data, 0) == magic, 'Invalid signature superblob')
    size, count = be32(data, 4), be32(data, 8)
    require(12 <= size <= len(data) and 0 < count <= max_count and 12 + 8 * count <= size,
            'Malformed superblob index')
    # LC_CODE_SIGNATURE allocation may exceed the indexed superblob. Pinned
    # zsign leaves previous signature tail bytes on repeat signing. These bytes
    # are NOT authenticated, and are disclosed separately by verify_binary.
    blobs, ranges = {}, []
    for i in range(count):
        kind, offset = struct.unpack_from('>II', data, 12 + 8 * i)
        require(kind not in blobs and 12 + 8 * count <= offset <= size - 8, 'Invalid/duplicate signature slot')
        length = be32(data, offset + 4)
        require(length >= 8 and offset + length <= size, 'Truncated signature slot')
        require(all(offset + length <= a or offset >= b for a, b in ranges), 'Overlapping signature slots')
        ranges.append((offset, offset + length))
        blobs[kind] = data[offset:offset + length]
    # Gaps may be alignment padding only, not an unindexed hidden blob.
    cursor = 12 + 8 * count
    for a, b in sorted(ranges):
        require(not any(data[cursor:a]), 'Nonzero unindexed signature data')
        cursor = b
    require(not any(data[cursor:size]), 'Nonzero unindexed signature tail')
    return blobs


def macho_signature(binary):
    require(len(binary) <= MAX_FILE and len(binary) >= 32 and binary[:4] == MACH_MAGICS[0],
            'Unsupported Mach-O (need thin little-endian arm64)')
    cpu, subtype, kind, count, cmd_size = struct.unpack_from('<IIIII', binary, 4)
    require(cpu == 0x100000c and subtype == 0 and kind in (2, 6, 8), 'Unsupported Mach-O CPU/subtype/filetype')
    require(0 < count <= 4096 and 8 * count <= cmd_size <= len(binary) - 32, 'Malformed load-command bounds')
    end, pos, signature = 32 + cmd_size, 32, None
    segments, entries, metadata = [], [], []
    for _ in range(count):
        require(pos + 8 <= end, 'Truncated load command')
        cmd, size = struct.unpack_from('<II', binary, pos)
        require(size >= 8 and size % 8 == 0 and pos + size <= end, 'Invalid load-command size')
        if cmd == 0x19:  # LC_SEGMENT_64
            require(size >= 72, 'Truncated segment command')
            segment_name = binary[pos + 8:pos + 24].split(b'\0', 1)[0]
            fileoff, filesize = struct.unpack_from('<QQ', binary, pos + 40)
            initprot, nsections = struct.unpack_from('<II', binary, pos + 60)
            require(nsections <= 4096 and size == 72 + 80 * nsections,
                    'Malformed segment sections')
            require(fileoff <= len(binary) and filesize <= len(binary) - fileoff,
                    'Truncated file-backed segment')
            sections = []
            for j in range(nsections):
                section = pos + 72 + 80 * j
                section_size = struct.unpack_from('<Q', binary, section + 40)[0]
                section_offset = struct.unpack_from('<I', binary, section + 48)[0]
                reloc_offset, reloc_count = struct.unpack_from('<II', binary, section + 56)
                metadata.append((reloc_offset, reloc_count * 8))
                section_flags = struct.unpack_from('<I', binary, section + 64)[0]
                if section_flags & 255 not in (1, 12, 18):  # zero-fill sections
                    require(section_offset >= fileoff and section_size <= fileoff + filesize - section_offset,
                            'Section exceeds file-backed segment')
                    sections.append((section_offset, section_size))
            segments.append((segment_name, fileoff, filesize, initprot, sections))
        elif cmd in (0x22, 0x80000022):  # LC_DYLD_INFO[_ONLY]
            require(size == 48, 'Malformed dyld-info command')
            metadata.extend(struct.unpack_from('<II', binary, pos + j) for j in range(8, 48, 8))
        elif cmd in (0x26, 0x29, 0x2b, 0x2e, 0x80000033, 0x80000034):
            # FUNCTION_STARTS, DATA_IN_CODE, DYLIB_CODE_SIGN_DRS,
            # LINKER_OPTIMIZATION_HINT, DYLD_EXPORTS_TRIE, DYLD_CHAINED_FIXUPS.
            require(size == 16, 'Malformed linkedit-data command')
            metadata.append(struct.unpack_from('<II', binary, pos + 8))
        elif cmd == 0x2:  # LC_SYMTAB (nlist_64 entries)
            require(size == 24, 'Malformed symbol-table command')
            symoff, nsyms, stroff, strsize = struct.unpack_from('<IIII', binary, pos + 8)
            metadata.extend(((symoff, nsyms * 16), (stroff, strsize)))
        elif cmd == 0xb:  # LC_DYSYMTAB
            require(size == 80, 'Malformed dynamic-symbol-table command')
            for j, width in ((32, 8), (40, 56), (48, 4), (56, 4), (64, 8), (72, 8)):
                dataoff, count = struct.unpack_from('<II', binary, pos + j)
                metadata.append((dataoff, count * width))
        elif cmd == 0x16:  # LC_TWOLEVEL_HINTS
            require(size == 16, 'Malformed two-level-hints command')
            dataoff, count = struct.unpack_from('<II', binary, pos + 8)
            metadata.append((dataoff, count * 4))
        elif cmd == 0x3:  # obsolete LC_SYMSEG
            require(size == 16, 'Malformed symbol-segment command')
            metadata.append(struct.unpack_from('<II', binary, pos + 8))
        elif cmd == 0x31:  # LC_NOTE
            require(size == 40, 'Malformed note command')
            metadata.append(struct.unpack_from('<QQ', binary, pos + 24))
        elif cmd in (0x21, 0x2c):  # LC_ENCRYPTION_INFO[_64]
            require(size >= 20 and struct.unpack_from('<I', binary, pos + 16)[0] == 0,
                    'Encrypted Mach-O unsupported')
        elif cmd == 0x80000028:  # LC_MAIN
            require(size == 24, 'Malformed LC_MAIN')
            entries.append(struct.unpack_from('<Q', binary, pos + 8)[0])
        if cmd == 0x1d:
            require(signature is None and size == 16, 'Duplicate/malformed LC_CODE_SIGNATURE')
            signature = struct.unpack_from('<II', binary, pos + 8)
        pos += size
    require(pos == end and signature is not None, 'Missing code signature/invalid command count')
    offset, size = signature
    require(offset >= end and 12 <= size <= MAX_SIGNATURE and offset + size == len(binary),
            'Signature must cover executable through EOF without unsealed trailing data')
    linkedit = [s for s in segments if s[0] == b'__LINKEDIT']
    require(len(linkedit) == 1 and not linkedit[0][3] & 4 and linkedit[0][1] <= offset
            and linkedit[0][1] + linkedit[0][2] == len(binary), 'Unsupported signature segment layout')
    require(all(s[0] == b'__LINKEDIT' or s[1] + s[2] <= offset for s in segments),
            'Unsigned file-backed executable segment')
    require(all(a + b <= offset for s in segments for a, b in s[4]), 'Unsigned file-backed section')
    # Signature allocation padding is deliberately disclosed as unauthenticated,
    # but must remain inert: dyld/linkedit data and relocation tables cannot use
    # any signature-region byte, including indexed blobs and leftover padding.
    require(all(not length or (start <= offset and length <= offset - start)
                for start, length in metadata), 'Unsigned Mach-O loader/linkedit metadata')
    require(all(e < offset for e in entries), 'Unsigned executable entry point')
    return offset, kind, superblob(binary[offset:], 0xfade0cc0)


def code_directory(blob, binary, limit, specials):
    require(len(blob) >= 44 and be32(blob, 0) == 0xfade0c02 and be32(blob, 4) == len(blob),
            'Invalid CodeDirectory')
    version, flags, hashes, ident, nspecial, ncode, code_limit = struct.unpack_from('>7I', blob, 8)
    hash_size, hash_type, platform, page = struct.unpack_from('4B', blob, 36)
    require(0x20001 <= version <= 0x20500 and not flags & 2, 'Unsupported/ad-hoc CodeDirectory')
    require(hash_type in (1, 2) and hash_size == (20 if hash_type == 1 else 32), 'Unsupported CodeDirectory hash')
    require(platform == 0 and blob[38] == 0 and page in range(12, 17) and be32(blob, 40) == 0, 'Unsupported CodeDirectory layout')
    header = 44
    if version >= 0x20100:
        header = 48
        require(len(blob) >= header and be32(blob, 44) == 0, 'Scatter CodeDirectory unsupported')
    team_offset = 0
    if version >= 0x20200:
        header = 52
        require(len(blob) >= header, 'Truncated CodeDirectory')
        team_offset = be32(blob, 48)
    if version >= 0x20300:
        header = 64
        require(len(blob) >= header and be32(blob, 52) == 0, 'Invalid CodeDirectory spare')
        limit64 = struct.unpack_from('>Q', blob, 56)[0]
        require(limit64 == 0, '64-bit code limits unsupported for bounded IPA files')
    if version >= 0x20400:
        header = 88
        require(len(blob) >= header, 'Truncated exec segment')
        base, length, _ = struct.unpack_from('>QQQ', blob, 64)
        require(base <= limit and length <= limit - base, 'Invalid signed exec-segment bounds')
    if version >= 0x20500:
        header = 96
        require(len(blob) >= header and be32(blob, 92) == 0, 'Pre-encrypt CodeDirectory unsupported')
    require(code_limit == limit and nspecial <= 7 and ncode == (limit + (1 << page) - 1) >> page,
            'Invalid CodeDirectory code coverage')
    start = hashes - nspecial * hash_size
    require(header <= start <= hashes and hashes + ncode * hash_size == len(blob), 'Invalid CodeDirectory hash bounds')
    ranges = []
    def string_at(offset):
        require(header <= offset < start, 'Invalid CodeDirectory string offset')
        stop = blob.find(b'\0', offset, start)
        require(stop != -1 and stop - offset <= 1024, 'Invalid CodeDirectory string')
        require(all(stop + 1 <= a or offset >= b for a, b in ranges), 'Overlapping CodeDirectory strings')
        ranges.append((offset, stop + 1))
        try:
            return blob[offset:stop].decode('utf-8')
        except UnicodeError as e:
            raise ValueError('Non-UTF8 CodeDirectory string') from e
    identifier = string_at(ident)
    require(identifier, 'Empty CodeDirectory identifier')
    team = string_at(team_offset) if team_offset else None
    algo = 'sha1' if hash_type == 1 else 'sha256'
    for i in range(ncode):
        actual = hashlib.new(algo, binary[i * (1 << page):min((i + 1) * (1 << page), limit)]).digest()
        require(actual == blob[hashes + i * hash_size:hashes + (i + 1) * hash_size], f'Code page hash mismatch at page {i}')
    for slot in range(1, max(nspecial, max(specials, default=0)) + 1):
        stored = blob[hashes - slot * hash_size:hashes - (slot - 1) * hash_size] if slot <= nspecial else b'\0' * hash_size
        value = specials.get(slot)
        expected = hashlib.new(algo, value).digest() if value is not None else b'\0' * hash_size
        require(stored == expected, f'Special slot {slot} hash mismatch (or unsupported nonzero slot)')
    return {'identifier': identifier, 'team_id': team, 'hash_type': algo, 'pages': ncode,
            'special_slots': nspecial, 'cdhash': hashlib.new(algo, blob).digest()[:20].hex()}


def ber_end(data, pos=0, depth=0):
    # Apple's codesign emits BER indefinite-length constructed CMS containers.
    # Bound depth and validate exact framing before OpenSSL normalizes to DER.
    require(depth <= 64 and pos + 2 <= len(data), 'Invalid/deep BER CMS')
    tag, length = data[pos], data[pos + 1]
    require(tag and tag & 31 != 31, 'Unsupported BER tag')
    pos += 2
    if length == 128:
        require(tag & 32, 'Primitive indefinite BER unsupported')
        while True:
            require(pos + 2 <= len(data), 'Truncated indefinite BER')
            if data[pos:pos + 2] == b'\0\0':
                return pos + 2
            pos = ber_end(data, pos, depth + 1)
    if length & 128:
        n = length & 127
        require(1 <= n <= 4 and pos + n <= len(data), 'Invalid BER length')
        length = int.from_bytes(data[pos:pos + n], 'big')
        pos += n
    end = pos + length
    require(end <= len(data), 'Truncated BER CMS')
    if tag & 32:
        while pos < end:
            pos = ber_end(data, pos, depth + 1)
        require(pos == end, 'Malformed BER constructed value')
    return end


def verify_cms(cms, directories, summaries, expected_der, ca_file=None):
    require(0 < len(cms) <= MAX_SIGNATURE and ber_end(cms) == len(cms), 'Invalid CMS framing/trailing data')
    normalized = openssl(['cms', '-cmsout', '-inform', 'DER', '-outform', 'DER'], cms)
    attrs = cms_attributes(normalized)
    with tempfile.TemporaryDirectory(prefix='ios-integrity-') as temp:
        tmp = Path(temp)
        (tmp / 'cms.der').write_bytes(cms)
        (tmp / 'cd').write_bytes(directories[0])
        argv = ['cms', '-verify', '-binary', '-inform', 'DER', '-in', tmp / 'cms.der',
                '-content', tmp / 'cd', '-signer', tmp / 'actual.pem', '-out', tmp / 'content']
        if ca_file:
            argv += ['-CAfile', Path(ca_file).resolve(), '-no-CApath', '-no-CAstore', '-purpose', 'any']
        else:
            argv += ['-noverify']
        openssl(argv)
        require((tmp / 'content').read_bytes() == directories[0], 'CMS verified unexpected detached content')
        actual_der = certificate_der(tmp / 'actual.pem')
        require(actual_der == expected_der, 'Actual CMS signer does not match expected certificate')
    # OpenSSL cryptographically validated these signed attrs. The CDHashes
    # attribute binds every alternate; verifying only CMS(primary) is not enough.
    oid1, oid2 = '2a864886f763640901', '2a864886f763640902'
    require(oid1 in attrs and len(attrs[oid1]) == 1, 'Authenticated cdhashes attribute missing')
    hashes = plist(der_value(normalized, attrs[oid1][0], 4)).get('cdhashes')
    require(hashes == [bytes.fromhex(s['cdhash']) for s in summaries], 'CMS cdhashes do not bind every CodeDirectory')
    require(oid2 in attrs and attrs[oid2], 'Authenticated full CD hash attribute missing')
    authenticated = []
    for node in attrs[oid2]:
        require(node[0] == 0x30, 'Invalid full CD hash attribute')
        pair = der_children(normalized, node)
        require(len(pair) == 2 and der_value(normalized, pair[0], 6) == bytes.fromhex('608648016503040201'),
                'Unsupported full CD hash algorithm')
        digest = der_value(normalized, pair[1], 4)
        require(len(digest) == 32, 'Invalid full CD digest')
        authenticated.append(digest)
    full_hashes = [hashlib.sha256(cd).digest() for cd, s in zip(directories, summaries) if s['hash_type'] == 'sha256']
    require(full_hashes and authenticated == full_hashes, 'CMS full SHA256 CD hashes mismatch')
    return hashlib.sha256(actual_der).hexdigest()


def verify_binary(binary, expected_der, info=None, resources=None, identifier=None, ca_file=None, bundle=False):
    limit, kind, slots = macho_signature(binary)
    cd_keys = sorted(k for k in slots if k == 0 or 0x1000 <= k <= 0x1005)
    require(cd_keys and cd_keys[0] == 0 and len(cd_keys) <= 6, 'Primary CodeDirectory missing')
    require(all(k in cd_keys or k in (2, 5, 7, 0x10000) for k in slots), 'Unsupported signature slot')
    specials = {}
    if info is not None:
        specials[1] = info
    if resources is not None:
        specials[3] = resources
    for slot, magic in ((2, 0xfade0c01), (5, 0xfade7171), (7, 0xfade7172)):
        if slot in slots:
            require(be32(slots[slot], 0) == magic, 'Invalid special-slot magic')
            specials[slot] = slots[slot]
    require(2 in slots, 'Requirements slot missing')
    # Validate requirements container but do not evaluate Apple requirement code.
    req = slots[2]
    if be32(req, 8) == 0:
        require(len(req) == 12, 'Invalid empty requirements')
    else:
        for value in superblob(req, 0xfade0c01).values():
            require(be32(value, 0) == 0xfade0c00 and len(value) >= 12, 'Invalid requirement blob')
    entitlements = None
    if 5 in slots:
        entitlements = plist(slots[5][8:])
    require(not bundle or (info is not None and resources is not None and kind == 2 and 5 in slots and 7 in slots),
            'App/extension lacks executable entitlements/resource seal')
    cds = [slots[k] for k in cd_keys]
    summaries = [code_directory(cd, binary, limit, specials) for cd in cds]
    require(len({(s['identifier'], s['team_id']) for s in summaries}) == 1, 'Inconsistent CodeDirectory identity')
    require(len({s['hash_type'] for s in summaries}) == len(summaries), 'Duplicate CodeDirectory hash algorithm')
    if identifier:
        require(summaries[0]['identifier'] == identifier, 'CodeDirectory bundle identifier mismatch')
    require(0x10000 in slots and be32(slots[0x10000], 0) == 0xfade0b01 and len(slots[0x10000]) > 8,
            'CMS signature missing/ad-hoc')
    fingerprint = verify_cms(slots[0x10000][8:], cds, summaries, expected_der, ca_file)
    padding = binary[limit + be32(binary, limit + 4):]
    return {'code_directories': summaries, 'signer_sha256': fingerprint,
            'unauthenticated_signature_allocation_padding_bytes': len(padding),
            'signature_allocation_padding_sha256': hashlib.sha256(padding).hexdigest(),
            'xml_entitlements_sha256': hashlib.sha256(slots[5]).hexdigest() if 5 in slots else None,
            'entitlements': entitlements}


class IPA:
    def __init__(self, path):
        require(Path(path).is_file() and Path(path).stat().st_size <= MAX_TOTAL, 'IPA file size limit exceeded')
        self.archive = zipfile.ZipFile(path)
        try:
            self.validate()
        except BaseException:
            self.archive.close()
            raise

    def validate(self):
        self.files = {}
        total = 0
        entries = self.archive.infolist()
        require(0 < len(entries) <= 20000, 'Archive entry limit exceeded')
        seen = set()
        for entry in entries:
            require(entry.orig_filename == entry.filename, 'Truncated/NUL archive path')
            name = path_name(entry.filename[:-1] if entry.is_dir() else entry.filename)
            require(name not in seen, 'Duplicate normalized archive path')
            seen.add(name)
            mode = entry.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)
                    and not entry.flag_bits & 1, 'Unsupported archive link/type/encryption')
            if entry.is_dir():
                require(stat.S_IFMT(mode) in (0, stat.S_IFDIR), 'Archive directory mode mismatch')
                require(entry.file_size == 0, 'Directory has contents')
                continue
            require(not stat.S_ISDIR(mode), 'Archive mode mismatch')
            total += entry.file_size
            require(entry.file_size <= MAX_FILE and total <= MAX_TOTAL, 'Archive size limit exceeded')
            require(entry.compress_size or entry.file_size == 0, 'Invalid compressed size')
            require(entry.file_size <= max(1024 * 1024, entry.compress_size * 1000), 'Excessive compression ratio')
            self.files[name] = entry
        require(all(not any('/'.join(PurePosixPath(n).parts[:i]) in self.files
                                for i in range(1, len(PurePosixPath(n).parts))) for n in seen),
                'Archive file/directory path collision')

    def read(self, name):
        require(name in self.files, 'Missing sealed file: ' + name)
        return self.archive.read(self.files[name])

    def magic(self, name):
        with self.archive.open(self.files[name]) as stream:
            return stream.read(4)


def omission(name, version):
    # Independent conservative allowlist; do not accept arbitrary signed rules
    # as an excuse for missing hashes. Pinned zsign omits only these files.
    if re.search(r'\.lproj/locversion\.plist$', name):
        return True
    return version == 2 and (name in ('Info.plist', 'PkgInfo') or PurePosixPath(name).name == '.DS_Store')


def verify_resources(ipa, folder, executable):
    seal = ipa.read(folder + '/_CodeSignature/CodeResources')
    resource = plist(seal)
    require(set(resource) == {'files', 'files2', 'rules', 'rules2'}, 'Unsupported CodeResources envelope')
    descendants = {n[len(folder) + 1:]: n for n in ipa.files if n.startswith(folder + '/')}
    excluded = {executable, '_CodeSignature/CodeResources'}
    result = {}
    for version, key in ((1, 'files'), (2, 'files2')):
        table = resource[key]
        require(isinstance(table, dict), 'Invalid resource table')
        for name, record in table.items():
            path_name(name)
            require(name not in excluded and name in descendants, 'Sealed resource missing/invalid')
            if isinstance(record, bytes) and version == 1:
                record = {'hash': record}
            require(isinstance(record, dict) and set(record) <= {'hash', 'hash2', 'optional'},
                    'Unsupported resource seal (nested code/symlink seals unsupported)')
            require(('hash' in record if version == 1 else 'hash2' in record), 'Resource hashes missing')
            require('optional' not in record or isinstance(record['optional'], bool), 'Invalid resource optional flag')
            contents = ipa.read(descendants[name])
            for field, algo, size in (('hash', 'sha1', 20), ('hash2', 'sha256', 32)):
                if field in record:
                    require(isinstance(record[field], bytes) and len(record[field]) == size
                            and record[field] == hashlib.new(algo, contents).digest(), 'Resource hash mismatch: ' + name)
        require(all(n in table or n in excluded or omission(n, version) for n in descendants),
                f'Unsealed resource in {key}')
        result[key] = len(table)
    # Omission rules are not integrity proof. In particular locversion.plist
    # can be absent from BOTH signed tables; surface its unauthenticated bytes
    # instead of letting the broad resource-verification flag hide this limit.
    result['table_omissions'] = {key: sorted(n for n in descendants
        if n not in excluded and n not in resource[key]) for key in ('files', 'files2')}
    result['unauthenticated_resource_paths'] = sorted(n for n in descendants
        if n not in excluded and n not in resource['files'] and n not in resource['files2'])
    return seal, result


def verify_ipa(path, expected_certificate, ca_file=None):
    expected_der = certificate_der(expected_certificate)
    if ca_file:
        require(Path(ca_file).is_file() and Path(ca_file).stat().st_size <= MAX_SIGNATURE,
                'Caller CA file missing/oversized')
    ipa = IPA(path)
    try:
        bundles, frameworks = {}, {}
        for name in ipa.files:
            if not name.endswith('/Info.plist'):
                continue
            folder = name[:-11]
            if folder.endswith(('.app', '.appex', '.framework')):
                info = plist(ipa.read(name))
                exe = info.get('CFBundleExecutable')
                require(isinstance(exe, str) and '/' not in exe and path_name(exe), 'Invalid bundle executable')
                bundle_id = info.get('CFBundleIdentifier')
                require(isinstance(bundle_id, str) and bundle_id, 'Missing bundle identifier')
                record = (folder, exe, bundle_id, ipa.read(name))
                if folder.endswith('.framework'):
                    require('/Frameworks/' in folder, 'Unsupported framework location')
                    frameworks[folder] = record
                else:
                    require(bundle_id in IDS and bundle_id not in bundles, 'Unexpected/duplicate app/extension')
                    bundles[bundle_id] = record
        require(set(bundles) == set(IDS), 'Expected all three application bundles')
        root = bundles[IDS[0]][0]
        require(len(PurePosixPath(root).parts) == 2 and root.startswith('Payload/') and root.endswith('.app'),
                'Unsupported main bundle layout')
        for bundle_id in IDS[1:]:
            folder = bundles[bundle_id][0]
            require(folder.startswith(root + '/PlugIns/') and len(PurePosixPath(folder).parts) == 4
                    and folder.endswith('.appex'), 'Unsupported extension layout')
        require(all(n.startswith(root + '/') for n in ipa.files), 'Files outside main app unsupported')
        # Discover all executable Mach-O content, including undeclared copies;
        # dylib/framework suffixes cannot hide an unsigned/non-Mach-O payload.
        declared = {r[0] + '/' + r[1] for r in list(bundles.values()) + list(frameworks.values())}
        binary_names = set()
        for name in ipa.files:
            if ipa.magic(name) in MACH_MAGICS:
                binary_names.add(name)
            elif name in declared or name.endswith('.dylib'):
                raise ValueError('Declared executable/dylib is not Mach-O')
        require(declared <= binary_names, 'Bundle executable missing')
        results, verified = [], set()
        teams = set()
        for folder, exe, bundle_id, info in list(bundles.values()) + list(frameworks.values()):
            resources, resource_summary = verify_resources(ipa, folder, exe)
            name = folder + '/' + exe
            result = verify_binary(ipa.read(name), expected_der, info, resources, bundle_id,
                                   ca_file, bundle_id in IDS)
            teams.add(result['code_directories'][0]['team_id'])
            result.pop('entitlements')  # Reports do not publish user entitlement contents.
            result.update(path=name, bundle_id=bundle_id, resources=resource_summary)
            results.append(result)
            verified.add(name)
        for name in sorted(binary_names - verified):
            require(name.endswith('.dylib') and '/Frameworks/' in name, 'Unrecognized nested executable')
            result = verify_binary(ipa.read(name), expected_der, ca_file=ca_file)
            teams.add(result['code_directories'][0]['team_id'])
            result.pop('entitlements')
            result['path'] = name
            results.append(result)
        require(len(teams) == 1 and None not in teams and '' not in teams, 'Signed code has inconsistent/missing team IDs')
        return {'status': 'cryptographically-verified-integrity', 'ipa_sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                'signer_sha256': hashlib.sha256(expected_der).hexdigest(), 'code_objects': results,
                'cms_signature_verified': True, 'code_and_resource_hashes_verified': True,
                'caller_ca_chain_verified': bool(ca_file), 'built_in_apple_trust_verified': False,
                'apple_revocation_verified': False, 'apple_device_installation_verified': False,
                'verification_limits': ['No built-in Apple trust or code-signing policy validation',
                    'No provisioning profile, device eligibility, revocation or install validation',
                    'No trusted signing timestamp validation',
                    'ZIP container metadata, compression and file permissions are not authenticated by code signatures',
                    'Allowlisted resource-table omissions are disclosed; locversion.plist omitted from both tables is not authenticated',
                    'Signature allocation padding outside the indexed superblob is not authenticated', 'Requirements expressions not evaluated; bytes authenticated',
                    'DER entitlements bytes authenticated; semantic equivalence with XML not evaluated',
                    'Caller CA validation uses OpenSSL purpose=any, not Apple platform policy']}
    finally:
        ipa.archive.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('ipa', type=Path)
    parser.add_argument('--expected-certificate', required=True, type=Path)
    parser.add_argument('--ca-file', type=Path, help='Optional explicit public trust store; no network/revocation checks')
    parser.add_argument('--output', type=Path, help='Write new JSON integrity report (never overwrite)')
    args = parser.parse_args()
    report = verify_ipa(args.ipa, args.expected_certificate, args.ca_file)
    encoded = json.dumps(report, indent=2) + '\n'
    if args.output:
        with args.output.open('x') as stream:
            stream.write(encoded)
    print(encoded, end='')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, struct.error, zipfile.BadZipFile,
            subprocess.TimeoutExpired, plistlib.InvalidFileException) as error:
        print(f'verify-ios-signatures-linux: {error}', file=sys.stderr)
        sys.exit(1)
