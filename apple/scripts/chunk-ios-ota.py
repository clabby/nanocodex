#!/usr/bin/env python3
"""Create an atomic NEW offline OTA deployment tree. Never sign, deploy or alter archives.

All canonical nonempty IPAs use chunks, including single-chunk small IPAs.
Cloudflare assets are limited to 25 MiB; IPA chunks are 24 MiB. SHA-256
verification blocks are 1 MiB, allowing the Worker to authenticate bounded buffers.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from contextlib import contextmanager

CHUNK = 24 * 1024 * 1024
BLOCK = 1024 * 1024
MAX_CHUNKS = 20
MAX_METADATA = 65536
REPO = Path(__file__).resolve().parents[2]
IPA = re.compile(r'builds/([0-9]+)/Nanocodex\.ipa')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(path):
    # Check lexical components BEFORE collapsing '..': symlink/../ escapes matter.
    lexical = Path(path)
    if not lexical.is_absolute():
        lexical = Path.cwd() / lexical
    for part in [lexical, *lexical.parents]:
        require(not part.is_symlink(), 'Symlinks are forbidden in source/destination paths.')
    return Path(os.path.abspath(lexical))


@contextmanager
def regular_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "Only regular source files are allowed.")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


def atomic_new_tree(source, destination):
    # rename() can silently replace an empty destination directory after a race.
    # Linux renameat2(RENAME_NOREPLACE) atomically preserves every existing tree.
    libc = ctypes.CDLL(None, use_errno=True)
    require(hasattr(libc, "renameat2"), "Atomic no-replace rename requires Linux renameat2.")
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(destination))


def inventory(root):
    files = {}
    for folder, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            path = Path(folder) / name
            mode = path.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'Only regular files/directories are allowed.')
            require(not path.is_symlink(), 'Symlink in archival assets.')
        for name in names:
            path = Path(folder) / name
            rel = path.relative_to(root).as_posix()
            require(not rel.startswith('__ota_chunks/') and not rel.endswith('.chunks.json'),
                    'Source must be archival unchunked assets, not a deployment tree.')
            # Hash with fixed-size reads; source rechecked after staging to reject changes.
            h = hashlib.sha256()
            with regular_file(path) as stream:
                for data in iter(lambda: stream.read(BLOCK), b''):
                    h.update(data)
            files[rel] = (path.stat().st_size, h.hexdigest())
    return files


def stage(source, destination):
    source, destination = safe_path(source), safe_path(destination)
    require(source.is_dir(), 'Source must be an existing archival directory.')
    require(not destination.exists(), 'Destination must be a NEW tree.')
    for path in (source, destination):
        require(not path.is_relative_to(REPO) and not REPO.is_relative_to(path), 'OTA trees must be outside the repository.')
    require(not destination.is_relative_to(source) and not source.is_relative_to(destination), 'Trees must not overlap.')
    require(destination.parent.is_dir(), 'Destination parent must already exist.')
    files = inventory(source)
    require(files, 'Empty archival tree.')
    chunked = []
    with tempfile.TemporaryDirectory(prefix='.' + destination.name + '-', dir=destination.parent) as temp:
        tree = Path(temp) / 'assets'
        tree.mkdir()
        for rel, (size, sha) in sorted(files.items()):
            path = source / rel
            target = tree / rel
            match = IPA.fullmatch(rel)
            if rel.lower().endswith('.ipa'):
                require(match is not None, 'IPA must use builds/<numeric>/Nanocodex.ipa.')
                checksum = path.with_name('sha256.txt')
                require(checksum.relative_to(source).as_posix() in files, 'IPA checksum is required.')
                require(files[checksum.relative_to(source).as_posix()][0] == 80, 'Invalid IPA checksum length.')
                with regular_file(checksum) as stream:
                    require(stream.read(81) == (sha + '  Nanocodex.ipa\n').encode(), 'IPA checksum mismatch.')
                require(size > 0, 'Empty IPA.')
            if match is None and size <= CHUNK:
                target.parent.mkdir(parents=True, exist_ok=True)
                copied = hashlib.sha256()
                with regular_file(path) as stream, target.open('wb') as dest:
                    for data in iter(lambda: stream.read(BLOCK), b''):
                        copied.update(data)
                        dest.write(data)
                require(target.stat().st_size == size and copied.hexdigest() == sha, 'Source changed during copy.')
                continue
            require(match is not None, 'Oversized non-IPA asset exceeds safe 24 MiB limit.')
            require(size <= CHUNK * MAX_CHUNKS, 'IPA exceeds supported chunk count.')
            chunks = []
            full = hashlib.sha256()
            with regular_file(path) as stream:
                remaining = size
                while remaining:
                    index = len(chunks)
                    chunk_size = min(CHUNK, remaining)
                    chunk_path = f'/__ota_chunks/{match[1]}/{sha}/{index:04d}.bin'
                    output = tree / chunk_path.lstrip('/')
                    output.parent.mkdir(parents=True, exist_ok=True)
                    hashes = []
                    chunk_hash = hashlib.sha256()
                    with output.open('wb') as dest:
                        left = chunk_size
                        while left:
                            data = stream.read(min(BLOCK, left))
                            require(len(data) == min(BLOCK, left), 'Source changed during chunking.')
                            hashes.append(hashlib.sha256(data).hexdigest())
                            chunk_hash.update(data)
                            full.update(data)
                            dest.write(data)
                            left -= len(data)
                    chunks.append(dict(path=chunk_path, size=chunk_size, sha256=chunk_hash.hexdigest(), blocks=hashes))
                    remaining -= chunk_size
                require(not stream.read(1), 'Source changed during chunking.')
            require(full.hexdigest() == sha, 'Source changed or hash mismatch.')
            metadata = dict(version=1, path='/' + rel, size=size, sha256=sha,
                            chunkSize=CHUNK, blockSize=BLOCK, chunks=chunks)
            encoded = (json.dumps(metadata, separators=(',', ':')) + '\n').encode()
            require(len(encoded) <= MAX_METADATA, 'Chunk metadata too large.')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.with_name(target.name + '.chunks.json').write_bytes(encoded)
            chunked.append('/' + rel)
        require(inventory(source) == files, 'Archival source changed while staging.')
        # NEW destination, same-filesystem atomic rename; refuse pre-existing destinations.
        require(not destination.exists(), 'Destination appeared during staging.')
        safe_path(source)
        safe_path(destination)
        atomic_new_tree(tree, destination)
    return dict(source_files=len(files), chunked_ipas=chunked, max_asset_bytes=CHUNK,
                destination=str(destination))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(stage(args.source, args.destination), sort_keys=True))
    except (ValueError, OSError) as error:
        raise SystemExit('Offline OTA chunk staging refused: ' + str(error))


if __name__ == '__main__':
    main()
