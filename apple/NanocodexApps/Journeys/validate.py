#!/usr/bin/env python3
"""Black-box preflight journeys through the shipped CLI, with inspectable JSON evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
binary = str(Path(args.binary).resolve())
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)

counter = '''import SwiftUI
struct Entry { var id: String; var amount: Int }
struct Counter: View {
    @Persisted("entries") var entries = [Entry(id: "seed", amount: 1)]
    @State var amount = "2"
    var body: some View {
        Form {
            Text("Count: \\(entries.count)")
            TextField("Amount", text: $amount)
            Button("Log") { entries.append(Entry(id: UUID().uuidString, amount: Int(amount) ?? 0)) }
            Button("Undo") { if !entries.isEmpty { entries.removeLast() } }
        }
    }
}
'''


def run(name, source, *, steps=None, state=None, agent=None, valid=True, stage='complete', message=None):
    request = {'runtime': 'swift-v1', 'source': source}
    if steps is not None:
        request['steps'] = steps
    if state is not None:
        request['state'] = state
    if agent is not None:
        request['agent_response'] = agent
    (out / f'{name}.request.json').write_text(json.dumps(request, indent=2))
    command = [binary, '--validate-json']
    result = subprocess.run(command, input=json.dumps(request), capture_output=True, text=True, timeout=60)
    (out / f'{name}.command.json').write_text(json.dumps(command))
    (out / f'{name}.stdout.json').write_text(result.stdout)
    (out / f'{name}.stderr.log').write_text(result.stderr)
    assert result.returncode == 0 and not result.stderr, (name, result.stderr)
    body = json.loads(result.stdout)
    assert body['valid'] == valid and body['stage'] == stage, (name, body)
    assert body['source_sha256'] == hashlib.sha256(source.encode()).hexdigest(), body
    assert body['tree_only'] is True and len(result.stdout.encode()) <= 524288, body
    if message:
        assert message in body['diagnostic']['message'], body
        assert isinstance(body['diagnostic']['line'], int), body
    print('PASS', name, body['stage'])
    return body


seed = {'future-key': {'preserved': True}}
result = run('counter-log-undo-reopen', counter, state=seed, steps=[
    {'action': 'expect', 'text': 'Count: 1'},
    {'action': 'set', 'binding': 'amount', 'value': '4'},
    {'action': 'tap', 'title': 'Log'},
    {'action': 'tap', 'title': 'Log'},
    {'action': 'tap', 'title': 'Undo'},
    {'action': 'expect', 'text': 'Count: 2'},
    {'action': 'reopen'},
    {'action': 'expect', 'text': 'Count: 2'},
])
assert len(result['persisted_test_state']['entries']) == 2
assert result['persisted_test_state']['entries'][1]['amount'] == 4
assert result['persisted_test_state']['future-key'] == seed['future-key']
assert result['rendered_tree'] and result['reopened_tree']
# Separate invocation must start with defaults rather than inherit previous validation writes.
fresh = run('isolated-next-invocation', counter, steps=[{'action': 'expect', 'text': 'Count: 1'}])
assert fresh['persisted_test_state'] == {}

for name, declaration in [
    ('record-id-initializer', 'struct Entry { var id = UUID().uuidString; var amount: Int }'),
    ('record-default-initializer', 'struct Entry { var id: String; var amount: Int = 0 }'),
]:
    source = counter.replace('struct Entry { var id: String; var amount: Int }', declaration)
    failure = run(name, source, valid=False, stage='parse', message='Record fields need a type')
    assert failure['diagnostic']['line'] == 2

run('optional-binding', '''struct App: View {
    @State var value = "2"
    var body: some View { Button("Parse") { if let n = Int(value) { value = String(n) } } }
}''', valid=False, stage='parse', message='optional binding is unsupported')
run('initialization-error', '''struct App: View {
    @State var value = 1 / 0
    var body: some View { Text(String(value)) }
}''', valid=False, stage='initialize_render', message='Division by zero')
run('render-error', '''struct App: View {
    var body: some View { Text(String(1 / 0)) }
}''', valid=False, stage='initialize_render', message='Division by zero')
failed = run('button-error-rollback', '''struct App: View {
    @Persisted("count") var count = 7
    var body: some View { Button("Fail") { count += 1; count = count / 0 } }
}''', state={'count': 7}, steps=[{'action': 'tap', 'title': 'Fail'}], valid=False, stage='tap', message='Division by zero')
assert failed['persisted_test_state'] == {'count': 7}
run('execution-bound', '''struct App: View {
    @State var count = 0
    var body: some View { Button("Spin") { while true { count += 1 } } }
}''', steps=[{'action': 'tap', 'title': 'Spin'}], valid=False, stage='tap', message='step limit')
agent_source = '''struct App: View {
    @State var answer = ""
    var body: some View {
        VStack { Button("Ask") { Task { answer = try await Agent.run("fixture prompt") } }; Text(answer) }
    }
}'''
blocked = run('agent-blocked', agent_source, steps=[{'action': 'tap', 'title': 'Ask'}], valid=False, stage='tap', message='Agent.run is disabled')
assert blocked['agent_fixture_calls'] == 0
assert 'already sent' not in blocked['diagnostic']['message']
fixture = run('agent-explicit-fixture', agent_source, agent='local fixture', steps=[
    {'action': 'tap', 'title': 'Ask'}, {'action': 'expect', 'text': 'local fixture'},
])
assert fixture['agent_fixture_calls'] == 1
run('missing-button', counter, steps=[{'action': 'tap', 'title': 'Missing'}], valid=False, stage='tap', message='found 0')
run('missing-binding', counter, steps=[{'action': 'set', 'binding': 'missing', 'value': 1}], valid=False, stage='set', message='No rendered control')
run('failed-expectation', counter, steps=[{'action': 'expect', 'text': 'not present'}], valid=False, stage='expect', message='Expected rendered Text')
run('steps-bound', counter, steps=[{'action': 'reopen'}] * 33, valid=False, stage='input', message='at most 32')
deep = 0
for _ in range(65):
    deep = [deep]
run('state-depth-bound', counter, state={'deep': deep}, valid=False, stage='input', message='64 nesting levels')
run('state-size-bound', counter, state={'large': 'x' * 262144}, valid=False, stage='input', message='256 KiB')
run('source-size-bound', counter + (' ' * 262144), valid=False, stage='input', message='256 KiB')
# A large but legal runtime tree returns bounded output with explicit truncation.
large = run('tree-output-bound', '''struct App: View {
    @State var text = ""
    var body: some View { VStack { TextField("Text", text: $text); Text(text) } }
}''', steps=[{'action': 'set', 'binding': 'text', 'value': 'x' * 200000}])
assert large['output_truncated'] is True
print('PASS native JSON preflight journeys; requests, commands and responses retained in', out)
