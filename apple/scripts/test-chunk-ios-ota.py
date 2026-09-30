#!/usr/bin/env python3
"""Offline chunk staging tests. Unsigned real IPA is transport-only evidence.
Optional --fixture-dir NEW-PATH retains a 51 MiB + fresh-IPA deployment for HTTP tests.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'apple/scripts/chunk-ios-ota.py'
spec = importlib.util.spec_from_file_location('chunker', SCRIPT)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture-dir', type=Path)
args, rest = parser.parse_known_args()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(mod.BLOCK), b''): h.update(block)
    return h.hexdigest()


def add_ipa(root, build, input_path=None, blocks=51):
    path = root / 'builds' / str(build) / 'Nanocodex.ipa'
    path.parent.mkdir(parents=True)
    h = hashlib.sha256()
    with path.open('wb') as out:
        if input_path:
            with input_path.open('rb') as source:
                for block in iter(lambda: source.read(mod.BLOCK), b''):
                    h.update(block); out.write(block)
        else:
            for i in range(blocks):
                block = bytes([i % 251]) * mod.BLOCK
                h.update(block); out.write(block)
    path.with_name('sha256.txt').write_text(h.hexdigest() + '  Nanocodex.ipa\n')
    return path


def check_tree(source, tree):
    for original in source.rglob('*'):
        if not original.is_file(): continue
        rel = original.relative_to(source)
        if original.suffix != '.ipa' or original.stat().st_size <= mod.CHUNK:
            assert digest(original) == digest(tree / rel), rel
            continue
        assert not (tree / rel).exists(), 'Large full IPA leaked into upload tree'
        meta = json.loads((tree / (str(rel) + '.chunks.json')).read_text())
        assert meta['size'] == original.stat().st_size
        assert meta['sha256'] == digest(original)
        full = hashlib.sha256()
        for c in meta['chunks']:
            chunk = tree / c['path'].lstrip('/')
            assert chunk.stat().st_size == c['size'] <= mod.CHUNK
            assert digest(chunk) == c['sha256']
            hashes = []
            with chunk.open('rb') as f:
                for b in iter(lambda: f.read(mod.BLOCK), b''):
                    full.update(b); hashes.append(hashlib.sha256(b).hexdigest())
            assert hashes == c['blocks']
        assert full.hexdigest() == meta['sha256']
    assert all(p.stat().st_size <= mod.CHUNK for p in tree.rglob('*') if p.is_file())


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chunk-test-', dir=ROOT.parent)
        self.base = Path(self.temp.name)
        self.source = self.base / 'archive'; self.source.mkdir()
        self.destination = self.base / 'upload'
    def tearDown(self): self.temp.cleanup()
    def refused(self, source=None, dest=None):
        with self.assertRaises((ValueError, OSError)):
            mod.stage(source or self.source, dest or self.destination)
        self.assertFalse(self.destination.exists())
    def test_synthetic_51_mib_and_memory(self):
        ipa = add_ipa(self.source, '51')
        original_sha = digest(ipa)
        self.source.joinpath('index.html').write_text('unchanged index')
        result = subprocess.run([sys.executable, str(SCRIPT), '--source', str(self.source),
                                 '--destination', str(self.destination)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['chunked_ipas'], ['/builds/51/Nanocodex.ipa'])
        check_tree(self.source, self.destination)
        self.assertEqual(digest(ipa), original_sha)
        meta = json.loads((self.destination/'builds/51/Nanocodex.ipa.chunks.json').read_text())
        self.assertEqual([c['size'] for c in meta['chunks']], [mod.CHUNK, mod.CHUNK, 3 * mod.BLOCK])
        # Standalone child measures staging, not fixture generation. Linux RSS is KiB.
        rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        self.assertLess(rss, 64 * 1024, f'Unbounded staging RSS {rss} KiB')
        print(f'51 MiB helper peak child RSS: {rss} KiB')
    def test_small_and_exact_chunk_remain_full(self):
        add_ipa(self.source, '1', blocks=1)
        add_ipa(self.source, '24', blocks=24)
        mod.stage(self.source, self.destination); check_tree(self.source, self.destination)
        self.assertFalse((self.destination/'__ota_chunks').exists())
    def test_invalid_sources_and_paths(self):
        self.refused()
        add_ipa(self.source, '1', blocks=1)
        self.refused(dest=self.source/'nested')
        self.refused(dest=ROOT/'forbidden-output')
        link = self.base/'link'; link.symlink_to(self.source, target_is_directory=True)
        self.refused(source=link)
        # A symlink that would disappear after abspath normalization is still refused.
        self.refused(source=link/'..'/'archive')
        (self.source/'evil').symlink_to('/etc/passwd')
        self.refused()
    def test_metadata_source_special_file_oversized_and_checksum(self):
        add_ipa(self.source, '1', blocks=1)
        checksum = self.source/'builds/1/sha256.txt'
        checksum.write_text('0'*64+'  Nanocodex.ipa\n'); self.refused()
        checksum.write_text('x' * (mod.BLOCK * 2)); self.refused()
        checksum.write_text(digest(checksum.with_name('Nanocodex.ipa'))+'  Nanocodex.ipa\n')
        metadata = self.source/'bad.chunks.json'; metadata.write_text('{}'); self.refused(); metadata.unlink()
        fifo = self.source/'fifo'; os.mkfifo(fifo); self.refused(); fifo.unlink()
        large = self.source/'bad.bin'
        with large.open('wb') as f: f.truncate(mod.CHUNK + 1)
        self.refused(); large.unlink()
        bad = self.source/'wrong.ipa'; bad.write_bytes(b'wrong-path'); self.refused()
    def test_existing_and_racing_destination_are_immutable(self):
        add_ipa(self.source, '1', blocks=1)
        self.destination.mkdir(); marker = self.destination/'keep'; marker.write_text('immutable')
        with self.assertRaises(ValueError): mod.stage(self.source, self.destination)
        self.assertEqual(marker.read_text(), 'immutable')
        marker.unlink(); self.destination.rmdir()
        original = mod.atomic_new_tree
        def race(source, destination):
            destination.mkdir()  # Even an empty preexisting directory must not be replaced.
            original(source, destination)
        with patch.object(mod, 'atomic_new_tree', race):
            with self.assertRaises(FileExistsError): mod.stage(self.source, self.destination)
        self.assertTrue(self.destination.is_dir())
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertFalse(any(p.name.startswith('.upload-') for p in self.base.iterdir()))
    def test_mutating_source_does_not_publish(self):
        add_ipa(self.source, '1', blocks=1)
        original = mod.inventory
        count = 0
        def changed(root):
            nonlocal count
            count += 1
            if count == 2: (root/'new.txt').write_text('source changed')
            return original(root)
        with patch.object(mod, 'inventory', changed): self.refused()
    def test_fresh_real_ipa_transport(self):
        candidates = sorted((ROOT/'output/ios-linux').glob('*/*unsigned.ipa'))
        if not candidates: self.skipTest('No fresh local unsigned IPA available')
        fresh = candidates[-1]
        add_ipa(self.source, '1790730578', input_path=fresh)
        mod.stage(self.source, self.destination); check_tree(self.source, self.destination)
        print(f'Real unsigned IPA transport fixture: {fresh.name}, {fresh.stat().st_size} bytes (not device/signing evidence)')


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(StagingTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful(): raise SystemExit(1)
    if args.fixture_dir:
        # A retained, NEW deployment tree enables parent live-Wrangler HTTP checks.
        with tempfile.TemporaryDirectory(prefix='chunk-fixture-archive-', dir=ROOT.parent) as tmp:
            archive = Path(tmp)
            add_ipa(archive, '51')
            fresh = sorted((ROOT/'output/ios-linux').glob('*/*unsigned.ipa'))
            if fresh: add_ipa(archive, '1790730578', input_path=fresh[-1])
            print(json.dumps(mod.stage(archive, args.fixture_dir), sort_keys=True))
