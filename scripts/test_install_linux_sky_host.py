import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ManagedReceiptTest(unittest.TestCase):
    def test_registration_is_opt_in_and_publishes_complete_launcher_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            runtime = root / 'runtime'
            for path in [runtime / 'bin/node', runtime / 'bin/node_repl',
                         runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
                         runtime / 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js']:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('#!/bin/sh\nexit 0\n')
                path.chmod(0o755)
            env = dict(os.environ, NANOCODEX_DIR=str(root / 'managed'))
            command = ['python3', str(Path(__file__).with_name('install-linux-sky-host.py')),
                       '--runtime', str(runtime)]
            receipt_path = root / 'managed/runtimes/openai-cua/provider.json'
            subprocess.run(command + ['--destination', str(root / 'unselected')],
                           env=env, check=True, capture_output=True)
            self.assertFalse(receipt_path.exists())
            # Replace an existing selection only after preparing its launcher.
            receipt_path.parent.mkdir(parents=True)
            receipt_path.write_text('{}')
            subprocess.run(command + ['--destination', str(root / 'selected'), '--register-managed'],
                           env=env, check=True, capture_output=True)
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt, dict(status='installed', transport='mcp',
                             executable=str(root / 'selected/cua-provider'), args=[], environment={},
                             dependency_contract='nanocodex-native-no-codex-v1'))
            self.assertTrue(os.access(receipt['executable'], os.X_OK))
            launcher = Path(receipt['executable']).read_text()
            self.assertIn('unset CODEX_CLI_PATH', launcher)
            self.assertIn('CUA_REPL_ENABLED_SURFACES=computer', launcher)
            self.assertNotIn('--disable-sandbox', launcher)
            self.assertNotIn('app-server', launcher)
            self.assertNotIn('export CODEX_CLI_PATH', launcher)
            # Even ambient Codex configuration must not reach the runtime.
            (runtime / 'bin/node').write_text('#!/bin/sh\nexec /usr/bin/env\n')
            output = subprocess.run([receipt['executable']], check=True, capture_output=True,
                text=True, env=dict(env, CODEX_CLI_PATH='/must-not-launch-codex')).stdout
            self.assertNotIn('CODEX_CLI_PATH=', output)
            self.assertIn('CUA_REPL_ENABLED_SURFACES=computer\n', output)
            rejected = root / 'browser-rejected'
            result = subprocess.run(command + ['--destination', str(rejected), '--surfaces', 'browser,computer'],
                env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('computer only', result.stderr)
            self.assertFalse(rejected.exists())
            result = subprocess.run(command + ['--destination', str(root / 'cli-rejected'), '--codex-cli', '/obsolete'],
                env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('unrecognized arguments', result.stderr)
            subprocess.run(['/bin/sh', '-n', receipt['executable']], check=True)
            self.assertEqual(list(receipt_path.parent.glob('.provider-*')), [])


if __name__ == '__main__':
    unittest.main()
