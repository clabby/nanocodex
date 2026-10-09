#!/usr/bin/env python3
"""Unified local TUI (ncl) feature journey: /mcp reload|login, /voice, /benchmark.

Real ncl over a PTY with a real stdio MCP server fixture; only the Claude
Messages HTTP provider is synthetic.
"""
from claude_code_fixture import normalize_request, wrap_tool
import argparse, fcntl, importlib.util, json, os, pty, re, select, shutil, struct, subprocess, termios, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

spec = importlib.util.spec_from_file_location('journey', Path(__file__).with_name('claude-scheduler-monitor-cli-journey.py'))
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
require, sse = helper.require, helper.sse

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('output/ncl-local-features') / uuid4().hex)
    args = parser.parse_args(); artifact = args.output.resolve(); artifact.mkdir(parents=True)
    root = Path(__file__).resolve().parents[2]
    workspace = artifact / 'workspace'; workspace.mkdir()
    (workspace / 'nanocodex.toml').write_text('[benchmark]\n')
    home = artifact / 'home'; (home / 'codex').mkdir(parents=True)
    env = {'HOME': str(home), 'CODEX_HOME': str(home / 'codex'), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'TERM': 'xterm-256color', 'NANOCODEX_COMPUTER': 'off'}
    requests = []
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['content-length'])))
            requests.append(normalize_request(request, artifact))
            (artifact / 'provider.json').write_text(json.dumps(requests, indent=2))
            response = sse(wrap_tool({'type': 'text', 'text': 'benchmark-turn-complete'}), request['model'])
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Content-Length', str(len(response))); self.end_headers(); self.wfile.write(response)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider); threading.Thread(target=server.serve_forever, daemon=True).start()
    node = shutil.which('node'); require(node, 'node is required for the stdio MCP fixture')
    command = [str(args.binary.resolve()), '--claude', '--model', 'claude-sonnet-5-5', '--claude-api-key', 'synthetic-key',
               '--claude-messages-url', f'http://127.0.0.1:{server.server_port}/v1/messages', '--cwd', str(workspace),
               '--browser=none', '--mcp-defaults', 'false', '--mcp-codex-config', 'false', '--web-search', 'false',
               '--image-generation', 'false', '--subagents', 'false', '--memory', 'false',
               '--mcp-stdio', f'stdio={node}', '--mcp-arg', f'stdio={root}/crates/nanocodex-oai-tools/tests/fixtures/mcp-stdio-server.mjs']
    master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=workspace, env=env, start_new_session=True); os.close(slave)
    transcript = bytearray(); screen = helper.TerminalScreen(rows=45, columns=160); seen = []
    def drain():
        while select.select([master], [], [], 0)[0]:
            try: chunk = os.read(master, 65536)
            except OSError: return
            if not chunk: return
            transcript.extend(chunk); screen.feed(chunk)
            if b'\x1b[6n' in chunk: os.write(master, b'\x1b[1;1R')
        text = screen.text()
        if text not in seen[-1:]: seen.append(text)
    def shown(text):
        drain(); flat = re.sub(r'\s+', '', text)
        return any(flat in re.sub(r'\s+', '', frame) for frame in seen[-400:])
    def wait(check, message, timeout=25):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            drain()
            if check(): return
            time.sleep(.03)
        raise AssertionError(message)
    def enter(text): os.write(master, text.encode() + b'\r')
    checks = []; outcome = {'success': False}
    try:
        wait(lambda: 'Enter send' in screen.text(), 'composer absent')
        time.sleep(1.5)
        enter('/mcp reload stdio'); wait(lambda: shown('Reloaded MCP server stdio ('), 'reload notice absent')
        checks.append('/mcp reload stdio reconnects the real stdio server and reports its tool count')
        enter('/mcp reload missing-server'); wait(lambda: shown('MCP server missing-server:'), 'unknown server error absent')
        checks.append('/mcp reload of an unconfigured server reports the MCP control error')
        enter('/mcp reload'); wait(lambda: shown('Usage: /mcp reload <server>'), 'bare reload usage absent')
        enter('/mcp login stdio'); wait(lambda: shown('MCP server stdio:'), 'login error for non-OAuth server absent')
        checks.append('/mcp login on a non-OAuth stdio server fails with the MCP error instead of opening a browser')
        enter('/mcp bogus'); wait(lambda: shown("Usage: /mcp login <server> or /mcp reload"), 'mcp usage absent')
        enter('/voice list'); wait(lambda: shown('Platform voices (default marin)'), 'voice list absent')
        checks.append('/voice list lists Codex/ChatGPT and platform Realtime voices')
        enter('/voice marin'); wait(lambda: shown('voice is unavailable with the selected harness'), 'voice start without Realtime client did not fail clearly')
        checks.append('/voice marin (platform voice) reaches local Realtime; the Claude harness has no Realtime client so it fails clearly')
        enter('/benchmark smoke extra'); wait(lambda: shown('Usage: /benchmark [profile]'), 'benchmark usage absent')
        before = len(requests)
        enter('/benchmark smoke'); wait(lambda: len(requests) > before and shown('benchmark-turn-complete'), 'benchmark turn absent', 40)
        last = json.dumps(requests[-1]['messages'])
        require('benchmark' in last and 'smoke' in last, 'benchmark instruction not sent')
        require(shown('/benchmark smoke'), 'transcript does not show the typed /benchmark command')
        checks.append('/benchmark smoke shows the typed command and sends the private benchmark workflow instruction')
        os.write(master, b'\x03\x03'); wait(lambda: process.poll() is not None, 'ncl did not exit', 15)
        outcome = {'success': True, 'checks': checks, 'provider_requests': len(requests)}
    finally:
        if process.poll() is None: process.kill(); process.wait()
        (artifact / 'tui.pty').write_bytes(transcript); (artifact / 'tui.screen.txt').write_text(screen.text())
        (artifact / 'frames.txt').write_text('\n=====\n'.join(seen[-60:]))
        (artifact / 'scenario.json').write_text(json.dumps({'command': command, 'environment': env, 'boundary': 'actual ncl TUI via PTY, real stdio MCP server, synthetic Messages HTTP only'}, indent=2))
        (artifact / 'outcome.json').write_text(json.dumps(outcome, indent=2)); server.shutdown(); print(json.dumps({'artifact': str(artifact), **outcome}))

if __name__ == '__main__': main()
