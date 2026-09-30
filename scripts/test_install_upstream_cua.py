"""The retired copy-only path must fail before installing or launching anything."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

class RetiredCopyInstallerTests(unittest.TestCase):
    def test_all_previous_surface_modes_fail_without_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'Source.app'
            source.mkdir()
            marker = source / 'unchanged'
            marker.write_text('unchanged')
            destination = root / 'destination'
            for surfaces in ('computer', 'browser', 'browser,computer'):
                with self.subTest(surfaces=surfaces):
                    result = subprocess.run([
                        sys.executable, str(Path(__file__).with_name('install-upstream-cua.py')),
                        '--source-app', str(source), '--destination', str(destination),
                        '--surfaces', surfaces,
                    ], env={**os.environ, 'CODEX_CLI_PATH': '/must/not/run'},
                       text=True, capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('copy-only CUA installer is retired', result.stderr)
                    self.assertIn('nanocodex computer setup', result.stderr)
                    self.assertFalse(destination.exists())
                    self.assertEqual(marker.read_text(), 'unchanged')

if __name__ == '__main__':
    unittest.main()
