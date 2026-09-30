#!/usr/bin/env python3
"""Losslessly DEFLATE-9 an IPA into a NEW file; never strip, sign or overwrite.

Packaging only: member bytes (including signatures), names, order, timestamps,
comments, extra fields, Unix/DOS attributes and archive comment are retained.
Compression sizes/CRC offsets, ZIP version requirements and descriptor/encoding
flags are ZIP transport details, not signed member data. Same input and Python/
zlib version produce deterministic bytes; cross-zlib byte identity is not promised.

Hard bounds: 480 MiB input/output, 1 GiB expanded total, 256 MiB per member,
4096 members, 8 MiB central directory, 1024-byte names, expansion ratio <=200.
Only nonencrypted STORE/DEFLATE ZIP32 archives with regular files/directories
are supported. ZIP64, symlinks, special files, ambiguous paths and duplicates
are refused. Fixed 1 MiB reads; metadata is bounded before ZipFile parses it.
No extraction. Output is verified then hard-linked atomically without replacement.
Larger compressed IPAs still need the existing <=24 MiB OTA chunking fallback.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import struct
import time
import unicodedata
import zipfile
import zlib

BLOCK = 1024 * 1024
MAX_ARCHIVE = 480 * BLOCK
MAX_TOTAL = 1024 * BLOCK
MAX_MEMBER = 256 * BLOCK
MAX_MEMBERS = 4096
MAX_DIRECTORY = 8 * BLOCK
MAX_NAME = 1024
MAX_RATIO = 200
META_FIELDS = ('filename', 'date_time', 'comment', 'extra', 'create_system',
               'external_attr', 'internal_attr', 'volume', 'reserved')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def open_parent(path):
    """Walk lexical parents through anchored no-follow directory descriptors."""
    path = os.fspath(path)
    require(path and not path.endswith('/'), 'Expected a file path.')
    parts = path.split('/')
    name = parts.pop()
    require(name not in ('', '.', '..'), 'Invalid file basename.')
    # O_PATH permits traversal of execute-only ancestors without directory listing.
    directory_flags = getattr(os, 'O_PATH', os.O_RDONLY) | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/' if path.startswith('/') else '.', directory_flags)
    try:
        for part in parts:
            if part in ('', '.'):
                continue
            next_fd = os.open(part, directory_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd, name
    except BaseException:
        os.close(fd)
        raise


def fingerprint(fd):
    s = os.fstat(fd)
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def digest(stream):
    stream.seek(0)
    sha = hashlib.sha256()
    for data in iter(lambda: stream.read(BLOCK), b''):
        sha.update(data)
    return sha.hexdigest()


def preflight(stream, size):
    """Bound central-directory allocation before Python's eager ZipFile parser."""
    require(0 < size <= MAX_ARCHIVE, 'Archive size outside 1..480 MiB bound.')
    stream.seek(max(0, size - 65557))
    tail = stream.read(65557)
    offset = tail.rfind(b'PK\x05\x06')
    require(offset >= 0 and offset + 22 <= len(tail), 'Missing ZIP32 end record.')
    end = tail[offset:offset + 22]
    _, disk, cd_disk, disk_count, count, cd_size, cd_offset, comment_size = struct.unpack('<4s4H2IH', end)
    require(offset + 22 + comment_size == len(tail), 'Trailing bytes or malformed ZIP comment.')
    require(disk == cd_disk == 0 and disk_count == count, 'Multidisk ZIP refused.')
    require(count != 65535 and cd_size != 0xffffffff and cd_offset != 0xffffffff, 'ZIP64 refused.')
    require(0 < count <= MAX_MEMBERS, 'Archive member count outside 1..4096 bound.')
    require(cd_size <= MAX_DIRECTORY, 'Central directory exceeds 8 MiB bound.')
    eocd_offset = size - len(tail) + offset
    require(cd_offset + cd_size == eocd_offset, 'ZIP64, prefixed or malformed directory refused.')
    # Do not trust EOCD's count: independently cap object count before eager parsing.
    stream.seek(cd_offset)
    observed = 0
    while stream.tell() < eocd_offset:
        header = stream.read(46)
        require(len(header) == 46 and header[:4] == b'PK\x01\x02', 'Malformed central directory.')
        name_size, extra_size, member_comment_size = struct.unpack_from('<3H', header, 28)
        require(0 < name_size <= MAX_NAME, 'Encoded member name exceeds 1024 bytes.')
        next_offset = stream.tell() + name_size + extra_size + member_comment_size
        require(next_offset <= eocd_offset, 'Truncated central directory entry.')
        observed += 1
        require(observed <= MAX_MEMBERS, 'Actual central member count exceeds 4096.')
        stream.seek(next_offset)
    require(observed == count, 'Actual central member count mismatch.')
    stream.seek(0)
    return count


def validate(infos):
    names, files, aliases = set(), set(), set()
    total = 0
    for info in infos:
        name = info.filename
        require(name == info.orig_filename and '\x00' not in name, 'NUL member path refused.')
        require(0 < len(name.encode('utf-8')) <= MAX_NAME, 'Member name exceeds 1024 bytes.')
        require(not name.startswith('/') and '\\' not in name and ':' not in name,
                'Absolute, Windows or ambiguous member path refused.')
        require(not any(ord(c) < 32 or ord(c) == 127 for c in name), 'Control character in member path.')
        key = name[:-1] if info.is_dir() else name
        require(all(p not in ('', '.', '..') for p in key.split('/')), 'Traversal or noncanonical member path.')
        require(key not in names, 'Duplicate file/directory member path.')
        names.add(key)
        alias = unicodedata.normalize('NFC', key).casefold()
        require(alias not in aliases, 'Case/Unicode aliased member paths refused.')
        aliases.add(alias)
        mode = stat.S_IFMT(info.external_attr >> 16)
        require(mode in (0, stat.S_IFREG, stat.S_IFDIR), 'Symlink or special archive member refused.')
        require(not mode or (mode == stat.S_IFDIR) == info.is_dir(), 'Member type/path mismatch.')
        require(not (info.external_attr & 0x10) or info.is_dir(), 'DOS directory/path mismatch.')
        if not info.is_dir():
            files.add(alias)
        require(not info.flag_bits & ~(0x8 | 0x800 | 0x6), 'Encrypted or unsupported ZIP flags.')
        require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsupported compression.')
        require(0 <= info.file_size <= MAX_MEMBER and 0 <= info.compress_size <= MAX_ARCHIVE,
                'Member exceeds size bounds.')
        require(not info.is_dir() or info.file_size == 0, 'Nonempty directory member refused.')
        require(info.file_size <= MAX_RATIO * max(1, info.compress_size), 'Expansion ratio exceeds 200.')
        total += info.file_size
        require(total <= MAX_TOTAL, 'Expanded archive exceeds 1 GiB.')
        extra = info.extra
        while extra:
            require(len(extra) >= 4, 'Truncated ZIP extra field.')
            kind, length = struct.unpack_from('<HH', extra)
            require(kind != 1 and len(extra) >= 4 + length, 'ZIP64 or truncated ZIP extra field.')
            extra = extra[4 + length:]
    for name in aliases:
        parts = name.split('/')
        require(not any('/'.join(parts[:i]) in files for i in range(1, len(parts))),
                'File member used as parent directory.')
    return total


def member_digest(stream, expected, target=None):
    sha, size = hashlib.sha256(), 0
    for data in iter(lambda: stream.read(BLOCK), b''):
        size += len(data)
        require(size <= expected and size <= MAX_MEMBER, 'Member expanded beyond declared/bounded size.')
        sha.update(data)
        if target is not None:
            target.write(data)
    require(size == expected, 'Member expanded size mismatch.')
    return sha.hexdigest()


def verify_staged(stream, originals, hashes, comment):
    stream.seek(0)
    with zipfile.ZipFile(stream) as archive:
        infos = archive.infolist()
        require(len(infos) == len(originals) and archive.comment == comment, 'Archive membership/comment changed.')
        for old, new, sha in zip(originals, infos, hashes):
            require(all(getattr(old, f) == getattr(new, f) for f in META_FIELDS), 'Member metadata changed.')
            require(new.compress_type == zipfile.ZIP_DEFLATED, 'Member not deflated.')
            require(new.file_size == old.file_size and new.CRC == old.CRC, 'Member size/CRC changed.')
            with archive.open(new) as member:
                require(member_digest(member, old.file_size) == sha, 'Member bytes changed.')


def atomic_new_file(parent_fd, temporary, destination, source_parent_fd=None):
    # link(2) fails with EEXIST even for a raced dangling symlink; never replace.
    os.link(temporary, destination, src_dir_fd=source_parent_fd if source_parent_fd is not None else parent_fd, dst_dir_fd=parent_fd,
            follow_symlinks=False)


def repack(source, destination):
    start = time.monotonic()
    source_parent, source_name = open_parent(source)
    output_parent = source_fd = temp_fd = staging_parent = None
    temporary = staging_directory = None
    try:
        source_fd = os.open(source_name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_parent)
        require(stat.S_ISREG(os.fstat(source_fd).st_mode), 'Source must be a regular non-symlink file.')
        initial = fingerprint(source_fd)
        output_parent, output_name = open_parent(destination)
        try:
            os.stat(output_name, dir_fd=output_parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('Output must be a NEW file; existing paths are never replaced.')
        with os.fdopen(source_fd, 'rb', closefd=False) as source_stream:
            count = preflight(source_stream, initial[2])
            before_sha = digest(source_stream)
            with zipfile.ZipFile(source_stream) as source_zip:
                infos = source_zip.infolist()
                require(len(infos) == count, 'Directory member count mismatch.')
                require(min(i.header_offset for i in infos) == 0, 'Prefixed archives refused.')
                total = validate(infos)
                staging_directory = '.ipa-repack-' + secrets.token_hex(16)
                os.mkdir(staging_directory, 0o700, dir_fd=output_parent)
                staging_parent = os.open(staging_directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=output_parent)
                os.fchmod(staging_parent, 0o700)
                temporary = 'archive.ipa'
                temp_fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
                                  0o600, dir_fd=staging_parent)
                with os.fdopen(temp_fd, 'w+b', closefd=False) as target_stream:
                    hashes = []
                    with zipfile.ZipFile(target_stream, 'w', compression=zipfile.ZIP_DEFLATED,
                                         compresslevel=9, allowZip64=False) as target_zip:
                        target_zip.comment = source_zip.comment
                        for info in infos:
                            new = copy.copy(info)
                            new.compress_type = zipfile.ZIP_DEFLATED
                            new._compresslevel = 9
                            with source_zip.open(info) as member, target_zip.open(new, 'w') as out:
                                hashes.append(member_digest(member, info.file_size, out))
                            # ZipFile supplies a default mode for zero external_attr; central
                            # attributes are written at close, so restore the exact original.
                            new.external_attr = info.external_attr
                            require(target_stream.tell() <= MAX_ARCHIVE, 'Output exceeds 480 MiB bound.')
                    target_stream.flush()
                    output_size = os.fstat(temp_fd).st_size
                    require(output_size <= MAX_ARCHIVE, 'Output exceeds 480 MiB bound.')
                    require(preflight(target_stream, output_size) == count, 'Output directory count changed.')
                    verify_staged(target_stream, infos, hashes, source_zip.comment)
                    after_sha = digest(target_stream)
                    require(digest(source_stream) == before_sha and fingerprint(source_fd) == initial,
                            'Source changed during repack.')
                    os.fsync(temp_fd)
                    atomic_new_file(output_parent, temporary, output_name, staging_parent)
                    sync_fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=output_parent)
                    try:
                        os.fsync(sync_fd)
                    finally:
                        os.close(sync_fd)
        return dict(input=str(source), output=str(destination), input_bytes=initial[2],
                    output_bytes=output_size, output_input_ratio=output_size / initial[2],
                    input_sha256=before_sha, output_sha256=after_sha, members=count,
                    expanded_bytes=total, compression='DEFLATE', level=9,
                    member_bytes_and_metadata_verified=True,
                    elapsed_seconds=round(time.monotonic() - start, 6),
                    apple_installability_verified=False)
    finally:
        if temporary is not None and staging_parent is not None:
            try:
                os.unlink(temporary, dir_fd=staging_parent)
            except FileNotFoundError:
                pass
        if staging_directory is not None and output_parent is not None:
            try:
                os.rmdir(staging_directory, dir_fd=output_parent)
            except FileNotFoundError:
                pass
        for fd in (temp_fd, staging_parent, source_fd, source_parent, output_parent):
            if fd is not None:
                os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(repack(args.input, args.output), sort_keys=True))
    except (ValueError, OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, zlib.error, struct.error, EOFError) as error:
        parser.exit(1, 'IPA repack refused: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
