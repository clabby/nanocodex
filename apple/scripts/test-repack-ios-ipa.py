#!/usr/bin/env python3
"""Offline lossless repack safety tests; optional --input-ipa verifies real IPAs.

Real fixture runs produce NEW outputs in a temporary directory and compare every
uncompressed byte and metadata field. No builds, signing or network operations.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import warnings
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).with_name('repack-ios-ipa.py')
spec = importlib.util.spec_from_file_location('repacker', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input-ipa', action='append', type=Path, default=[])
args, rest = parser.parse_known_args()


def archive(path, entries=None, compression=zipfile.ZIP_STORED):
    if entries is None:
        entries = [('Payload/', b'', stat.S_IFDIR | 0o755),
                   ('Payload/App.app/', b'', stat.S_IFDIR | 0o755),
                   ('Payload/App.app/App', b'\xcf\xfa\xed\xfe' + b'code' * 2000, stat.S_IFREG | 0o755),
                   ('Payload/App.app/Info.plist', b'exact\x00bytes', stat.S_IFREG | 0o644),
                   ('Payload/App.app/_CodeSignature/CodeResources', b'\x00cms\xffresource', stat.S_IFREG | 0o644),
                   ('Payload/App.app/unicod\u00e9', b'UTF8 filename', stat.S_IFREG | 0o640)]
    with warnings.catch_warnings(), zipfile.ZipFile(path, 'w', compression=compression) as z:
        warnings.simplefilter('ignore', UserWarning)
        z.comment = b'archive comment retained'
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name, (2026, 9, 30, 12, 34, 56))
            info.create_system = 3
            info.external_attr = mode << 16 | (0x10 if name.endswith('/') else 0)
            info.internal_attr = 1
            info.comment = b'member comment'
            info.extra = b'\xfe\xca\x03\x00abc'
            info.compress_type = compression
            z.writestr(info, data)


def audit(before, after):
    """Independent audit using byte equality, not only helper hash assertions."""
    with zipfile.ZipFile(before) as src, zipfile.ZipFile(after) as dst:
        a, b = src.infolist(), dst.infolist()
        assert len(a) == len(b)
        assert src.comment == dst.comment
        for old, new in zip(a, b):
            for field in mod.META_FIELDS:
                assert getattr(old, field) == getattr(new, field), (old.filename, field)
            assert old.file_size == new.file_size and old.CRC == new.CRC
            assert new.compress_type == zipfile.ZIP_DEFLATED
            # Fixed-size independent byte comparison, including EOF.
            with src.open(old) as x, dst.open(new) as y:
                while True:
                    left, right = x.read(mod.BLOCK), y.read(mod.BLOCK)
                    assert left == right, old.filename
                    if not left:
                        break
        return len(a)


class RepackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ipa-repack-test-', dir=SCRIPT.resolve().parents[2].parent)
        self.base = Path(self.temp.name)
        self.source = self.base / 'input.ipa'
        self.output = self.base / 'output.ipa'
        archive(self.source)
    def tearDown(self):
        self.temp.cleanup()
    def refused(self, source=None, output=None):
        with self.assertRaises((ValueError, OSError, zipfile.BadZipFile, RuntimeError)):
            mod.repack(source or self.source, output or self.output)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.base.glob('.ipa-repack-*')))
    def test_bytes_metadata_determinism_and_no_mutation(self):
        before = self.source.read_bytes()
        first = mod.repack(self.source, self.output)
        second = self.base / 'second.ipa'
        mod.repack(self.source, second)
        self.assertEqual(first['members'], 6)
        self.assertEqual(audit(self.source, self.output), 6)
        self.assertEqual(self.output.read_bytes(), second.read_bytes())
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(first['input_sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(first['output_sha256'], hashlib.sha256(self.output.read_bytes()).hexdigest())
    def test_zero_attributes_are_retained(self):
        archive(self.source, [('zero', b'data', stat.S_IFREG)])
        data = bytearray(self.source.read_bytes())
        central = data.index(b'PK\x01\x02')
        data[central+38:central+42] = b'\x00' * 4
        self.source.write_bytes(data)
        mod.repack(self.source, self.output)
        self.assertEqual(audit(self.source, self.output), 1)
        with zipfile.ZipFile(self.output) as z:
            self.assertEqual(z.infolist()[0].external_attr, 0)
    def test_new_output_requires_existing_parent_and_no_overwrite(self):
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError): mod.repack(self.source, self.output)
        self.assertEqual(self.output.read_bytes(), b'keep')
        self.output.unlink()
        before = self.source.read_bytes()
        with self.assertRaises(ValueError): mod.repack(self.source, self.source)
        self.assertEqual(self.source.read_bytes(), before)
        self.refused(output=self.base / 'missing' / 'output.ipa')
    def test_atomic_racing_file_and_dangling_symlink(self):
        original = mod.atomic_new_file
        for kind in ('file', 'symlink'):
            def race(parent, temporary, name, source_parent=None):
                if kind == 'file': self.output.write_bytes(b'raced immutable')
                else: self.output.symlink_to(self.base / 'missing')
                original(parent, temporary, name, source_parent)
            with patch.object(mod, 'atomic_new_file', race), self.assertRaises(FileExistsError):
                mod.repack(self.source, self.output)
            if kind == 'file': self.assertEqual(self.output.read_bytes(), b'raced immutable')
            else: self.assertTrue(self.output.is_symlink())
            self.output.unlink()
            self.assertFalse(list(self.base.glob('.ipa-repack-*')))
    def test_staging_is_private_and_descriptor_anchored(self):
        original = mod.atomic_new_file
        def checked(parent, temporary, name, source_parent=None):
            self.assertIsNotNone(source_parent)
            self.assertNotEqual(parent, source_parent)
            self.assertEqual(stat.S_IMODE(os.fstat(source_parent).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(temporary, dir_fd=source_parent).st_mode), 0o600)
            original(parent, temporary, name, source_parent)
        with patch.object(mod, 'atomic_new_file', checked): mod.repack(self.source, self.output)
        self.assertEqual(audit(self.source,self.output),6)
        self.assertFalse(list(self.base.glob('.ipa-repack-*')))

    def test_filesystem_symlinks_and_special_files(self):
        link = self.base / 'link'; link.symlink_to(self.source)
        self.refused(source=link)
        folder = self.base / 'folder'; folder.mkdir()
        parent_link = self.base / 'parent-link'; parent_link.symlink_to(folder)
        self.refused(output=parent_link / 'out.ipa')
        # Symlink lexical component remains forbidden even if '..' would normalize it away.
        self.refused(output=parent_link / '..' / 'out.ipa')
        self.output.symlink_to(self.base / 'missing')
        with self.assertRaises(ValueError): mod.repack(self.source, self.output)
        self.assertTrue(self.output.is_symlink()); self.output.unlink()
        fifo = self.base / 'fifo'; os.mkfifo(fifo)
        self.refused(source=fifo)
        self.refused(source=folder)
    def test_traversal_absolute_ambiguous_and_duplicate_names(self):
        for name in ('../escape', '/absolute', 'C:/drive', 'a\\b', 'a/./b', 'a//b', './a', 'a\nb', 'a/../b'):
            archive(self.source, [(name, b'bad', stat.S_IFREG | 0o644)])
            self.refused()
        for entries in ([('a', b'1', stat.S_IFREG), ('a', b'2', stat.S_IFREG)],
                        [('a', b'1', stat.S_IFREG), ('a/', b'', stat.S_IFDIR)],
                        [('a/b', b'1', stat.S_IFREG), ('a', b'2', stat.S_IFREG)],
                        [('A', b'1', stat.S_IFREG), ('a', b'2', stat.S_IFREG)],
                        [('a/B', b'1', stat.S_IFREG), ('A', b'2', stat.S_IFREG)],
                        [('caf\u00e9', b'1', stat.S_IFREG), ('cafe\u0301', b'2', stat.S_IFREG)]):
            archive(self.source, entries); self.refused()
        archive(self.source, [('abc', b'1', stat.S_IFREG)])
        self.source.write_bytes(self.source.read_bytes().replace(b'abc', b'a\x00c'))
        self.refused()
    def test_member_special_types_directories_and_unsupported_flags(self):
        for mode in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFCHR, stat.S_IFBLK):
            archive(self.source, [('bad', b'bad', mode | 0o777)]); self.refused()
        for entries in ([('bad/', b'content', stat.S_IFDIR)], [('bad/', b'', stat.S_IFREG)],
                        [('bad', b'', stat.S_IFDIR)]):
            archive(self.source, entries); self.refused()
        archive(self.source, [('bad', b'data', stat.S_IFLNK)])
        with zipfile.ZipFile(self.source) as z: infos = z.infolist()
        infos[0].create_system = 0
        with self.assertRaises(ValueError): mod.validate(infos)
        infos[0].external_attr = stat.S_IFREG << 16
        for bit in (1, 0x20, 0x40, 0x2000):
            infos[0].flag_bits = bit
            with self.assertRaises(ValueError): mod.validate(infos)
        archive(self.source, [('bad', b'data', stat.S_IFREG)], compression=zipfile.ZIP_BZIP2)
        self.refused()
    def test_crc_truncated_and_trailing_archives(self):
        archive(self.source, [('a', b'member bytes', stat.S_IFREG)])
        good = self.source.read_bytes()
        self.source.write_bytes(good.replace(b'member bytes', b'member byteX'))
        self.refused()
        for data in (good[:-1], good + b'trailing', b'not a zip'):
            self.source.write_bytes(data); self.refused()
    def test_central_directory_preflight_and_zip64_bounds(self):
        good = self.source.read_bytes()
        end = good.rfind(b'PK\x05\x06')
        for relative, encoded in ((8, struct.pack('<HH', 5000, 5000)),
                                  (12, struct.pack('<I', mod.MAX_DIRECTORY + 1)),
                                  (16, b'\xff' * 4), (4, struct.pack('<H', 1))):
            data = bytearray(good); data[end+relative:end+relative+len(encoded)] = encoded
            self.source.write_bytes(data); self.refused()
        # A lying EOCD low count is rejected before ZipFile eagerly creates objects.
        data = bytearray(good); data[end+8:end+12] = struct.pack('<HH', 1, 1)
        self.source.write_bytes(data)
        with patch.object(mod.zipfile, 'ZipFile', side_effect=AssertionError('must not parse')):
            self.refused()
        self.source.write_bytes(good)
        with patch.object(mod, 'MAX_ARCHIVE', len(good) - 1): self.refused()
        with patch.object(mod, 'MAX_MEMBERS', 1): self.refused()
        with zipfile.ZipFile(self.source) as z: infos = z.infolist()
        for extra in (b'\x01\x00\x00\x00', b'\xfe\xca\x04\x00a', b'abc'):
            infos[0].extra = extra
            with self.assertRaises(ValueError): mod.validate(infos)
    def test_declared_expansion_name_total_and_member_bounds(self):
        archive(self.source, [('large', b'0' * (2 * mod.BLOCK), stat.S_IFREG)], zipfile.ZIP_DEFLATED)
        self.refused()  # Actual compact bomb-like input, ratio >200.
        archive(self.source)
        for bound, value in (('MAX_MEMBER', 4), ('MAX_TOTAL', 4), ('MAX_NAME', 4)):
            with patch.object(mod, bound, value): self.refused()
        with zipfile.ZipFile(self.source) as z: infos = z.infolist()
        infos[2].file_size = mod.MAX_MEMBER + 1
        with self.assertRaises(ValueError): mod.validate(infos)
    def test_changed_source_and_corrupt_staged_output_never_publish(self):
        original = mod.verify_staged
        def mutate(stream, infos, hashes, comment):
            original(stream, infos, hashes, comment)
            with self.source.open('ab') as out: out.write(b'changed')
        with patch.object(mod, 'verify_staged', mutate): self.refused()
        archive(self.source)
        def corrupt(stream, infos, hashes, comment):
            hashes[2] = '0' * 64
            original(stream, infos, hashes, comment)
        with patch.object(mod, 'verify_staged', corrupt): self.refused()
    def test_actual_streamed_size_is_checked(self):
        import io
        with self.assertRaises(ValueError): mod.member_digest(io.BytesIO(b'xx'), 1)
        with self.assertRaises(ValueError): mod.member_digest(io.BytesIO(b''), 1)
    def test_output_size_bound_cleanup(self):
        # Input fits max but an incompressible small file grows when deflated.
        archive(self.source, [('a', os.urandom(20), stat.S_IFREG)])
        with patch.object(mod, 'MAX_ARCHIVE', self.source.stat().st_size): self.refused()
    def test_51_mib_streaming_memory_and_large_output_fallback(self):
        block = os.urandom(mod.BLOCK)
        with zipfile.ZipFile(self.source, 'w') as z:
            with z.open('Payload/App.app/App', 'w') as member:
                for _ in range(51): member.write(block)
        result = subprocess.run([sys.executable, str(SCRIPT), '--input', str(self.source),
                                 '--output', str(self.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(audit(self.source, self.output), 1)
        self.assertGreater(report['output_bytes'], 24 * mod.BLOCK)
        # Child process tests streaming helper, not in-process fixture generation.
        rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        self.assertLess(rss, 64 * 1024, f'Unbounded child RSS {rss} KiB')
        print(f'51 MiB archive repack peak child RSS: {rss} KiB; output {report["output_bytes"]} bytes (>24MiB, OTA chunks still required)')
    def test_optional_real_ipas(self):
        for n, source in enumerate(args.input_ipa):
            output = self.base / f'real-{n}.ipa'
            second = self.base / f'real-{n}-deterministic.ipa'
            report = mod.repack(source, output)
            mod.repack(source, second)
            self.assertEqual(audit(source, output), report['members'])
            with output.open('rb') as a, second.open('rb') as b:
                self.assertEqual(mod.digest(a), mod.digest(b))
            print('Real IPA audited: ' + json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]] + rest)
