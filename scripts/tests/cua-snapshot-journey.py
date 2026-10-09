#!/usr/bin/env python3
"""Live macOS CUA MCP journey. Requires a provisioned, permitted native provider.

python3 scripts/tests/cua-snapshot-journey.py --provider /absolute/cua-provider
Uses only a synthetic app. Writes requests, results and screenshots to output/.
"""
import argparse
import base64
import json
from pathlib import Path
import plistlib
import queue
import re
import subprocess
import threading
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/cua-snapshots' / uuid4().hex)
    args = parser.parse_args()
    evidence = args.output.resolve()
    evidence.mkdir(parents=True)
    app = evidence / 'Snapshot Fixture.app'
    executable = app / 'Contents/MacOS/snapshot-fixture'
    executable.parent.mkdir(parents=True)
    with (app / 'Contents/Info.plist').open('wb') as file:
        plistlib.dump({'CFBundleExecutable': executable.name, 'CFBundleIdentifier': 'dev.nanocodex.snapshot.' + uuid4().hex,
                      'CFBundleName': 'CUA Snapshot Fixture', 'CFBundlePackageType': 'APPL'}, file)
    command = ['clang', '-fobjc-arc', '-framework', 'Cocoa', str(ROOT / 'scripts/tests/fixtures/cua-snapshot-app.m'), '-o', str(executable)]
    subprocess.run(command, check=True)
    app_process = subprocess.Popen([str(executable)])
    output = queue.Queue()
    transcript = (evidence / 'mcp.jsonl').open('w')
    stderr = (evidence / 'provider.stderr').open('w')
    provider = subprocess.Popen([str(args.provider.resolve())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
    def collect():
        try:
            for line in provider.stdout:
                output.put(json.loads(line))
        finally:
            output.put(None)
    threading.Thread(target=collect, daemon=True).start()
    next_id = 0
    def rpc(method, params):
        nonlocal next_id
        next_id += 1
        request = {'jsonrpc': '2.0', 'id': next_id, 'method': method, 'params': params}
        transcript.write(json.dumps({'request': request}) + '\n'); transcript.flush()
        provider.stdin.write(json.dumps(request) + '\n'); provider.stdin.flush()
        while True:
            response = output.get(timeout=60)
            if response is None:
                raise RuntimeError('Provider exited; inspect provider.stderr')
            transcript.write(json.dumps({'response': response}) + '\n'); transcript.flush()
            if response.get('id') == next_id:
                if 'error' in response:
                    raise RuntimeError(response['error'])
                result = response['result']
                if result.get('isError'):
                    raise RuntimeError(result)
                return result
    def js(code):
        return rpc('tools/call', {'name': 'js', 'arguments': {'code': code},
                   '_meta': {'openai/confirmation_policies': {'computer_use': 'No confirmation policy applies.', 'browser_use': 'No confirmation policy applies.'}}})
    def texts(result):
        return '\n'.join(c['text'] for c in result.get('content', []) if c['type'] == 'text')
    def full(result, count):
        text = texts(result)
        assert 'Stable snapshot anchor' in text, 'Full observation lost unchanged anchor'
        assert 'Increment counter' in text, 'Full observation lost unchanged click target'
        assert 'Count: ' + str(count) in text, 'Observation has wrong counter value'
        return text
    try:
        rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'snapshot-journey', 'version': '1'}})
        provider.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n'); provider.stdin.flush()
        rpc('tools/list', {})
        state = full(js('var fixture = await cua.getApp(' + json.dumps(str(app)) + ');'), 0)
        button = int(re.search(r'(\d+) button Increment counter', state)[1])
        full(js(f'await fixture.click({button}); await fixture.getAXState();'), 1)
        full(js('await fixture.getAXState();'), 1)
        muted = texts(js('var silentState = await fixture.getAXState({emit:false}); if (!silentState.includes("Stable snapshot anchor")) throw Error("silent observation incomplete"); nodeRepl.write("SILENT_OK");'))
        assert 'SILENT_OK' in muted and 'Stable snapshot anchor' not in muted, 'emit:false emitted the tree'
        combined = js('await fixture.getAXStateAndScreenshot();')
        full(combined, 1)
        images = [c for c in combined.get('content', []) if c['type'] == 'image']
        assert images, 'Combined observation lost screenshot'
        suffix = 'png' if images[0]['mimeType'] == 'image/png' else 'jpg'
        (evidence / ('snapshot.' + suffix)).write_bytes(base64.b64decode(images[0]['data']))
        rpc('tools/call', {'name': 'js_reset', 'arguments': {}})
        full(js('var fixture = await cua.getApp(' + json.dumps(str(app)) + ');'), 1)
        full(js('await fixture.getAXState();'), 1)
        receipt = {'passed': True, 'provider': str(args.provider.resolve()), 'command': ['python3', str(Path(__file__).resolve()), '--provider', str(args.provider.resolve()), '--output', str(evidence)],
                   'verified': ['full snapshot after native click', 'unchanged repeated observation retains all controls', 'emit:false returns full state without emitting it', 'combined full tree and screenshot', 'full default survives REPL reset']}
        (evidence / 'summary.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt))
    finally:
        provider.stdin.close()
        try:
            provider.wait(timeout=15)
        except subprocess.TimeoutExpired:
            provider.terminate(); provider.wait(timeout=10)
        app_process.terminate(); app_process.wait(timeout=10)
        transcript.close(); stderr.close()


if __name__ == '__main__':
    main()
