#!/usr/bin/env python3
"""Default Code Mode CLI/HTTP-SSE/stdio-MCP CUA journey; no live computer access.

python3 scripts/tests/computer-harness-cli-journey.py --binary target/debug/nanocodex
All commands, model requests, MCP traffic and outcomes remain in ignored output/.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import shlex
import struct
import subprocess
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
CATALOG = [
    {'name': name, 'description': 'Exact provider documentation for ' + name + '\n  Preserve whitespace and punctuation.',
     'inputSchema': {'type': 'object', 'properties': {'code': {'type': 'string'}, 'opaque': {'type': 'object', 'additionalProperties': True}}, 'additionalProperties': True}}
    for name in ('js', 'js_reset', 'js_add_node_module_dir', 'future__tool', 'trailing__')
] + [{'name': 'turn_ended', 'description': 'Hidden lifecycle hook', 'inputSchema': {'type': 'object'}, '_meta': {'ui': {'visibility': []}}}]
PREFIX = 'mcp__cua_repl__'
STEPS = [('js', {'code': 'text', 'opaque': {'nested': [1, True, None]}, 'future_argument': 'unchanged'}),
         ('future__tool', {'code': 'image'}), ('js', {'code': 'error'}), ('js_reset', {}), ('js', {'code': 'recovered'}), ('trailing__', {'code': 'trailing-name'})]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return base64.b64encode(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b'')).decode()


def mcp(log):
    """External provider stub selected by an executable launcher, not internal mocks."""
    for line in sys.stdin:
        request = json.loads(line)
        with Path(log).open('a') as file:
            file.write(json.dumps({'pid': os.getpid(), 'request': request}) + '\n')
        if 'id' not in request:
            continue
        method = request['method']
        if method == 'initialize':
            result = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'synthetic-cua', 'version': '1'}}
        elif method == 'tools/list':
            result = {'tools': CATALOG}
        elif method == 'tools/call':
            code = request['params']['arguments'].get('code', 'reset')
            result = {'content': [{'type': 'text', 'text': 'provider-' + code}], 'isError': code == 'error'}
            if code == 'image':
                result['content'].append({'type': 'image', 'mimeType': 'image/png', 'data': png()})
        else:
            raise AssertionError(method)
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/computer-harness-cli' / uuid4().hex)
    args = parser.parse_args()
    artifact = args.output.resolve()
    artifact.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location('native_fixture', ROOT / 'scripts/tests/claude-native-cli-journey.py')
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    outcomes = []
    sessions = set()
    for mode in ('codex', 'claude'):
        for scenario in ('enabled', 'off', 'workspace-disabled', 'bad-provider', *(['denied'] if mode != 'codex' else [])):
            directory = artifact / (mode + '-' + scenario)
            workspace = directory / 'workspace'
            workspace.mkdir(parents=True)
            (directory / 'home').mkdir()
            log = directory / 'mcp.jsonl'
            launcher = directory / 'provider'
            launcher.write_text('#!/bin/sh\nexec ' + shlex.join([sys.executable, str(Path(__file__).resolve()), '--mcp', str(log)]) + '\n')
            launcher.chmod(0o755)
            requests, errors = [], []
            enabled = scenario in ('enabled', 'denied')
            steps = STEPS if scenario == 'enabled' else ([STEPS[0]] if scenario == 'denied' else ([('catalog', {})] if scenario != 'bad-provider' else []))

            class Provider(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def do_POST(self):
                    request = json.loads(self.rfile.read(int(self.headers['content-length'])))
                    stage = len(requests)
                    requests.append(request)
                    try:
                        require(self.path == ('/v1/responses' if mode == 'codex' else '/v1/messages'), 'wrong inference route')
                        require(self.headers.get('Authorization') == 'Bearer synthetic-codex-key' if mode == 'codex' else self.headers.get('x-api-key') == 'synthetic-claude-key', 'wrong synthetic auth')
                        tools = request.get('tools', []) + [tool for item in request.get('input', []) if item.get('type') == 'additional_tools' for tool in item['tools']]
                        require({tool['name'] for tool in tools} == {'exec', 'wait'}, 'harness must expose only exec/wait')
                        description = next(tool['description'] for tool in tools if tool['name'] == 'exec')
                        for item in CATALOG[:-1]:
                            declaration = 'declare const tools: { ' + PREFIX + item['name'] + '(args: { code?: string; opaque?: { [key: string]: unknown; }; [key: string]: unknown; }): Promise<unknown>; };'
                            if enabled:
                                if mode == 'codex':
                                    require(item['description'] + '\n\nexec tool declaration:\n```ts\n' + declaration in description, 'Codex schema/description rendering changed')
                                else:
                                    prefix = '- `tools.' + PREFIX + item['name'] + '`: ' + item['description'] + '\nInput schema: '
                                    require(prefix in description, 'Claude Code Mode description changed')
                                    schema, _ = json.JSONDecoder().raw_decode(description.split(prefix, 1)[1])
                                    require(schema == item['inputSchema'], 'Claude Code Mode schema changed')
                            else:
                                require(PREFIX + item['name'] not in description, 'disabled catalog contains CUA')
                        require('turn_ended' not in json.dumps(tools), 'hidden lifecycle tool exposed')
                        if stage:
                            if mode == 'codex':
                                receipts = [item for item in request['input'] if item.get('type') in ('custom_tool_call_output', 'function_call_output')]
                                receipt = receipts[-1]
                            else:
                                receipts = [block for message in request['messages'] for block in message.get('content', []) if isinstance(block, dict) and block.get('type') == 'tool_result']
                                receipt = receipts[-1]
                            serialized = json.dumps(receipt)
                            if steps[stage - 1][0] == 'catalog':
                                require('catalog-verified' in serialized, f'nested disabled catalog failed: {receipt}')
                            elif scenario == 'denied':
                                require('denied' in serialized.lower() or 'not allowed' in serialized.lower(), f'permission failure absent: {receipt}')
                            else:
                                marker = 'provider-' + steps[stage - 1][1].get('code', 'reset')
                                require(marker in serialized, f'missing output {marker}: {receipt}')
                                if stage == 2:
                                    require(png() in json.dumps(request), f'image bytes lost: {receipt}')
                                    if mode == 'codex':
                                        require(any(block.get('type') == 'input_image' and block.get('image_url') == 'data:image/png;base64,' + png() for block in receipt.get('output', [])), 'image was not emitted as native Responses image')
                                    else:
                                        require(any(block.get('type') == 'image' and block.get('source', {}).get('media_type') == 'image/png' for block in receipt.get('content', [])), 'image was not emitted as native Messages image')
                                if stage == 3:
                                    blocks = receipt.get('output', receipt.get('content', []))
                                    payloads = [json.loads(block['text']) for block in blocks if block.get('text', '').startswith('{')]
                                    require(any(payload.get('isError') is True for payload in payloads), 'nested provider error lost isError')
                        if stage < len(steps):
                            name, inputs = steps[stage]
                            name = PREFIX + name
                            code = ''
                            if stage == 0:
                                code += 'const catalog = ALL_TOOLS.filter(t=>t.name.startsWith("mcp__cua_repl__")); text(catalog); '
                                expected = [{'name': PREFIX + item['name'], 'description': item['description']} for item in CATALOG[:-1]] if enabled else []
                                code += 'if (JSON.stringify(catalog.sort((a,b)=>a.name.localeCompare(b.name))) !== JSON.stringify(' + json.dumps(sorted(expected, key=lambda item: item['name'])) + ')) throw Error("exact nested catalog mismatch"); '
                                code += 'text("catalog-verified"); '
                            if steps[stage][0] != 'catalog':
                                code += 'try { const r = await tools.' + name + '(' + json.dumps(inputs) + '); text(r); '
                            if stage == 1:
                                code += 'for (const b of r.content || []) if (b.type === "image") image(b);'
                            if steps[stage][0] != 'catalog':
                                code += ' } catch(error) { text(error); }'
                            name, inputs = 'exec', {'code': code}
                        else:
                            require(stage == len(steps), 'unexpected inference retry')
                            name, inputs = 'text', 'computer-journey-complete'
                    except Exception as error:
                        errors.append(str(error))
                        name, inputs = 'text', 'fixture-failed'
                    (directory / 'transport.json').write_text(json.dumps(requests, indent=2))
                    ident = 'call_' + str(stage)
                    if mode != 'codex':
                        block = {'type': 'text', 'text': inputs} if name == 'text' else {'type': 'tool_use', 'id': ident, 'name': name, 'input': inputs}
                        response = fixture.sse(block, request['model'])
                    else:
                        output = {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': inputs}]} if name == 'text' else {'type': 'custom_tool_call', 'name': name, 'call_id': ident, 'input': inputs['code']}
                        response = ('data: ' + json.dumps({'type': 'response.completed', 'response': {'id': ident, 'status': 'completed', 'output': [output], 'usage': {'input_tokens': 1, 'input_tokens_details': {'cached_tokens': 0}, 'output_tokens': 1, 'output_tokens_details': {'reasoning_tokens': 0}, 'total_tokens': 2}}}) + '\n\n').encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Content-Length', str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)

            server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base = f'http://127.0.0.1:{server.server_port}'
            command = [str(args.binary.resolve()), 'run', '--harness', 'codex' if mode == 'codex' else 'claude', '--model', 'gpt-6.1-sol' if mode == 'codex' else 'claude-sonnet-5-5', '--api-key', 'synthetic-codex-key', '--api-base-url', base + '/v1', '--responses-transport', 'https', '--claude-api-key', 'synthetic-claude-key', '--claude-messages-url', base + '/v1/messages', '--cwd', str(workspace), '--rollouts', 'false', '--browser=none', '--mcp-defaults', 'false', '--mcp-codex-config', 'false', '--web-search', 'false', '--image-generation', 'false', '--subagents', 'false', '--memory', 'false']
            if scenario == 'workspace-disabled':
                command += ['--workspace-tools', 'false']
            if scenario == 'denied':
                policy = directory / 'permissions.json'
                policy.write_text(json.dumps({'permissions': {'defaultMode': 'full-access', 'deny': [PREFIX + 'js']}}))
                command += ['--claude-permissions', str(policy)]
            command += ['Exercise synthetic computer provider only.']
            environment = {'HOME': str(directory / 'home'), 'CODEX_HOME': str(directory / 'codex-home'), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'NANOCODEX_COMPUTER': 'off' if scenario == 'off' else str(directory / 'absent-provider') if scenario == 'bad-provider' else str(launcher)}
            (directory / 'scenario.json').write_text(json.dumps({'command': command, 'shell_command': shlex.join(command), 'environment': environment, 'expected': scenario, 'catalog': CATALOG, 'steps': steps, 'boundary': 'real CLI, Responses HTTPS transport mode over loopback HTTP / Messages HTTP SSE, real tool runtime and stdio MCP; synthetic inference and external CUA only'}, indent=2))
            outcome = {'mode': mode, 'scenario': scenario, 'success': False}
            try:
                result = subprocess.run(command, cwd=workspace, env=environment, capture_output=True, timeout=60)
                (directory / 'stdout.jsonl').write_bytes(result.stdout)
                (directory / 'stderr.log').write_bytes(result.stderr)
                require(not errors, '; '.join(errors))
                rows = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
                calls = [row for row in rows if row['request']['method'] == 'tools/call' and row['request']['params']['name'] != 'turn_ended']
                if scenario == 'bad-provider':
                    require(result.returncode != 0 and not requests, 'bad provider did not fail before inference')
                    require(b'absent-provider' in result.stderr, 'startup failure lacks provider path')
                else:
                    require(result.returncode == 0, result.stderr.decode(errors='replace'))
                    require(b'computer-journey-complete' in result.stdout, 'missing final answer')
                    require(len(requests) == len(steps) + 1, 'wrong inference request count')
                    require(len(calls) == (len(steps) if scenario == 'enabled' else 0), f'unexpected provider effects: {calls}')
                    if scenario in ('off', 'workspace-disabled'):
                        require(not rows, 'disabled provider was started')
                    if scenario == 'enabled':
                        require(len({row['pid'] for row in calls}) == 1, 'session process not retained')
                        metadata = [row['request']['params']['_meta']['x-codex-turn-metadata'] for row in calls]
                        session = metadata[0]['session_id']
                        require(session and session not in sessions, 'session identity missing or reused')
                        sessions.add(session)
                        for row, meta, (name, inputs) in zip(calls, metadata, steps):
                            require(row['request']['params']['name'] == name and row['request']['params']['arguments'] == inputs, 'provider dispatch mutated arguments')
                            require(meta['session_id'] == session and meta['thread_id'] == session and meta.get('turn_id') and meta.get('call_id'), 'dispatch identity lost')
                        require(len({meta['call_id'] for meta in metadata}) == len(steps), 'call identity reused')
                outcome.update(success=True, inference_requests=len(requests), provider_calls=len(calls))
            except Exception as error:
                outcome['error'] = str(error)
            finally:
                server.shutdown()
                (directory / 'outcome.json').write_text(json.dumps(outcome, indent=2))
                outcomes.append(outcome)
                (artifact / 'outcome.json').write_text(json.dumps(outcomes, indent=2))
                print(json.dumps({'artifact': str(directory), **outcome}), flush=True)
    require(all(outcome['success'] for outcome in outcomes), 'Some computer journeys failed; inspect ' + str(artifact / 'outcome.json'))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--mcp':
        mcp(sys.argv[2])
    else:
        main()
