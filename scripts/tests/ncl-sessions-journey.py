#!/usr/bin/env python3
"""Local (ncl) sessions journey through the shipped CLI in a real tmux PTY.

python3 scripts/tests/ncl-sessions-journey.py --binary target/debug/ncl

Covers: resume replay, the native tui-control registration and rollout history
paging, /attach, the branch navigator (edit prompt 2 into a forked branch and
switch back), /btw, /collapse, /split and /close. A local Responses server
records every model request. Synthetic homes, requests, screen frames and the
outcome are retained in ignored output/. Requires tmux.
"""
import argparse, glob, json, os, shlex, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

os.umask(0o022)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", required=True, type=Path)
parser.add_argument("--output", type=Path, default=Path("output/ncl-sessions") / uuid4().hex)
args = parser.parse_args()
art = args.output.absolute(); art.mkdir(parents=True, exist_ok=True)
binary = args.binary.absolute()
if binary.name != "ncl":
    # The local command tree is selected by the invoked name.
    (art / "bin").mkdir(exist_ok=True)
    alias = art / "bin" / "ncl"
    if not alias.exists():
        os.link(binary, alias)
    binary = alias
home, ws = art / "home", art / "ws"; home.mkdir(exist_ok=True); ws.mkdir(exist_ok=True)
checks, requests = [], []

def sse(text):
    ev = [{"type": "response.created", "response": {"id": "r"}},
          {"type": "response.output_item.done", "item": {"type": "message", "role": "assistant", "id": "m" + str(len(requests)),
           "content": [{"type": "output_text", "text": text}]}},
          {"type": "response.completed", "response": {"id": "r", "usage": {"input_tokens": 1, "input_tokens_details": None,
           "output_tokens": 1, "output_tokens_details": None, "total_tokens": 2}}}]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in ev).encode()

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        requests.append(body)
        last = ""
        for item in reversed(body.get("input", [])):
            if item.get("role") == "user":
                last = " ".join(p.get("text", "") for p in item.get("content", []) if isinstance(p, dict)); break
        word = next((w for w in last.replace("\n", " ").split(" ") if w.isupper() and "_" in w), "UNKNOWN")
        payload = sse("ANSWER_" + word)
        self.send_response(200); self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
    def log_message(self, *a): pass

server = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/v1"
common = ["--api-key", "synthetic-test-key", "--api-base-url", url, "--responses-transport", "https", "--browser=none",
          "--mcp-defaults", "false", "--web-search", "false", "--image-generation", "false"]
env = {"PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "NANOCODEX_COMPUTER": "off", "HOME": str(home), "CODEX_HOME": str(home)}
S = f"ncl-sessions-{uuid4().hex[:8]}"
frames = []

def tmux(*a, **k):
    return subprocess.run(["tmux", *a], capture_output=True, text=True, **k)

def screen():
    out = tmux("capture-pane", "-p", "-t", S + ":0.0").stdout
    frames.append(out); (art / "frames.txt").write_text("\n=====FRAME=====\n".join(frames)); return out

def wait(pred, what, timeout=40):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        s = screen()
        if pred(s): return s
        time.sleep(0.5)
    raise AssertionError(f"timed out: {what}")

def keys(*k): tmux("send-keys", "-t", S + ":0.0", *k)
def typ(t): tmux("send-keys", "-t", S + ":0.0", "-l", t)
def check(name, ok, **detail):
    checks.append({"check": name, "ok": bool(ok), **detail})
    (art / "outcome.json").write_text(json.dumps({"checks": checks, "requests": len(requests)}, indent=2))
    if not ok: raise AssertionError(name)

def rollouts(): return sorted((home / "sessions").rglob("rollout-*.jsonl"))
def completed(p): return sum(1 for l in p.read_text().splitlines() if '"task_complete"' in l)

try:
    r = subprocess.run([str(binary), "run", *common, "--cwd", str(ws), "--repeat", "2", "FIRST_PROMPT"], cwd=ws, env=env,
                       capture_output=True, text=True, timeout=90)
    (art / "run.stderr.txt").write_text(r.stderr)
    check("run records a 2-turn thread", r.returncode == 0 and len(rollouts()) == 1 and completed(rollouts()[0]) == 2)
    original = rollouts()[0]
    thread = json.loads(original.read_text().splitlines()[0])["payload"]["id"]
    tmux("kill-session", "-t", S)
    cmd = "env " + " ".join(shlex.quote(f"{k}={v}") for k, v in env.items()) + " " + shlex.join([str(binary), "resume", thread, *common])
    # remain-on-exit keeps a crashed TUI's last screen inspectable until cleanup.
    tmux("new-session", "-d", "-x", "170", "-y", "50", "-s", S, "-c", str(ws), cmd + "; echo EXITED $?",
         ";", "set-option", "-t", S, "remain-on-exit", "on")
    for k, v in env.items(): tmux("set-environment", "-t", S, k, v)
    s = wait(lambda s: s.count("ANSWER_FIRST_PROMPT") >= 2, "resume replays both turns")
    check("resume replays history", True, answers=s.count("ANSWER_FIRST_PROMPT"))

    # Native tui-control: registration kind and rollout history paging.
    regs = [json.loads(Path(p).read_text()) for p in glob.glob(str(home / "nanocodex/tui/instances/*.json"))]
    reg = next(r for r in regs if r.get("active_session_id"))
    (art / "registration.kind.txt").write_text(json.dumps({k: v for k, v in reg.items() if k != "auth_token"}, indent=2))
    check("control registers kind native", reg.get("backend") == "native" and bool((reg.get("conversation") or {}).get("rollout_path")), backend=reg.get("backend"))
    sock = socket.socket(socket.AF_UNIX); sock.connect(reg["socket_path"]); f = sock.makefile("rw")
    f.write(json.dumps({"protocol_version": 1, "instance_id": reg["instance_id"], "auth_token": reg["auth_token"]}) + "\n"); f.flush()
    hello = json.loads(f.readline()); n = [0]
    def req(method, params):
        n[0] += 1; rid = f"j{n[0]}"; f.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n"); f.flush()
        while True:
            fr = json.loads(f.readline())
            if fr.get("id") == rid: return fr["result"]
    session = reg["active_session_id"]
    p1 = req("history.list", {"expected_session_id": session, "limit": 3})
    p2 = req("history.list", {"expected_session_id": session, "limit": 3, "cursor": p1["next_cursor"], "boundary": p1["boundary"]})
    again = req("history.list", {"expected_session_id": session, "limit": 3, "boundary": p1["boundary"]})
    ids1 = [x["record_id"] for x in p1["records"]]; ids2 = [x["record_id"] for x in p2["records"]]
    (art / "history.json").write_text(json.dumps({"hello": hello, "page1": p1, "page2": p2}, indent=2)[:200000])
    check("history.list pages backwards with stable cursors", ids1 and ids2 and not set(ids1) & set(ids2)
          and [x["record_id"] for x in again["records"]] == ids1, page1=ids1, page2=ids2)
    one = req("history.read", {"expected_session_id": session, "record_id": ids1[0], "boundary": p1["boundary"]})
    check("history.read returns a record", "status" not in one or one.get("status") != "rejected", keys=list(one)[:6])
    stale = req("history.list", {"expected_session_id": "not-this-session", "limit": 1})
    check("history.list rejects a stale session", "session_changed" in json.dumps(stale), result=stale)

    # /attach opens the local session picker.
    typ("/attach"); keys("Enter")
    time.sleep(3); s = screen(); keys("Escape"); time.sleep(1)
    check("/attach lists local sessions", "FIRST_PROMPT" in s and "Could not load" not in s)

    # Branch navigator: edit prompt 2 into a new branch forked after turn 1.
    keys("C-M-b")
    s = wait(lambda s: "Prompts on this branch" in s, "navigator opens", 15)
    check("Ctrl+Alt+B opens the navigator with both prompts", "1. FIRST_PROMPT" in s and "2. FIRST_PROMPT" in s)
    keys("e"); time.sleep(0.5)
    for _ in range(len("FIRST_PROMPT")): keys("BSpace")
    typ("EDITED_PROMPT"); keys("Enter")
    end = time.monotonic() + 40
    while time.monotonic() < end and len(rollouts()) < 2: time.sleep(0.5)
    forks = [p for p in rollouts() if p != original]
    check("edit forks the rollout after turn 1", len(forks) == 1 and completed(forks[0]) >= 1, forks=[str(p) for p in forks])
    fork_thread = json.loads(forks[0].read_text().splitlines()[0])["payload"]["id"]
    s = wait(lambda s: s.count("ANSWER_FIRST_PROMPT") == 1, "branch transcript shows one turn", 40)
    check("branch shows history before the edited prompt", True)
    time.sleep(5); s = screen()
    check("edited prompt submitted on the branch", "ANSWER_EDITED_PROMPT" in s or any("EDITED_PROMPT" in json.dumps(b.get("input", [])) for b in requests))
finally:
    try:
        keys("C-M-b"); time.sleep(2); s = screen(); keys("Up"); keys("Enter")
        s = wait(lambda s: s.count("ANSWER_FIRST_PROMPT") >= 2, "switch back to main", 40)
        checks.append({"check": "switch back to the original branch", "ok": True})
    except Exception as error:
        checks.append({"check": "switch back to the original branch", "ok": False, "error": str(error)})
    try:
        typ("/btw SIDE_QUESTION"); keys("Enter")
        s = wait(lambda s: "ANSWER_SIDE_QUESTION" in s, "btw answer", 40)
        side = [b for b in requests if "SIDE_QUESTION" in json.dumps(b.get("input", []))]
        checks.append({"check": "/btw answers from the forked main snapshot", "ok": bool(side) and "FIRST_PROMPT" in json.dumps(side[-1].get("input", []))})
        before = len(requests)
        typ("/collapse"); keys("Enter")
        end = time.monotonic() + 40
        while time.monotonic() < end and not any("side exploration" in json.dumps(b.get("input", [])) for b in requests[before:]):
            time.sleep(0.5)
        time.sleep(2); s = screen()
        collapsed = [b for b in requests[before:] if "side exploration" in json.dumps(b.get("input", []))
                     or ("<btw_conversation>" in json.dumps(b.get("input", [])) and "ANSWER_SIDE_QUESTION" in json.dumps(b.get("input", [])))]
        checks.append({"check": "/collapse hands the btw thread to main and closes its pane",
                       "ok": bool(collapsed) and ("Collapsed /btw" in s or "BTW Codex thread ID" in s) and "\u203a BTW" not in s,
                       "mode": "inline" if collapsed and "<btw_conversation>" in json.dumps(collapsed[0].get("input", [])) else "thread"})
        typ("/btw SPLIT_QUESTION"); keys("Enter")
        wait(lambda s: "ANSWER_SPLIT_QUESTION" in s, "split btw answer", 40)
        typ("/split"); keys("Enter")
        end = time.monotonic() + 15
        panes, refusal = "", ""
        while time.monotonic() < end:
            panes = tmux("list-panes", "-t", S, "-F", "#{pane_index} #{pane_start_command}").stdout
            s = screen()
            if panes.count("\n") >= 2: break
            if "not saved to disk" in s:
                refusal = "not saved to disk"; break
            time.sleep(0.3)
        time.sleep(2)
        split_screen = tmux("capture-pane", "-p", "-t", S + ":0.1").stdout if panes.count("\n") >= 2 else ""
        (art / "split-pane.txt").write_text(panes + "\n----\n" + split_screen)
        # Legacy parity: a fork without its own rollout cannot be resumed elsewhere and /split says so.
        checks.append({"check": "/split opens a resuming tmux pane, or refuses an unsaved fork like legacy",
                       "ok": ("resume" in panes and panes.count("\n") >= 2) or bool(refusal), "refusal": refusal})
        if panes.count("\n") < 2:
            typ("/close"); keys("Enter"); time.sleep(1)
        tmux("kill-pane", "-t", S + ":0.1")
        typ("/btw CLOSE_QUESTION"); keys("Enter")
        wait(lambda s: "ANSWER_CLOSE_QUESTION" in s, "close btw answer", 40)
        typ("/close"); keys("Enter"); time.sleep(3); s = screen()
        before = len(requests)
        typ("AFTER_CLOSE_PROMPT"); keys("Enter")
        wait(lambda s: "ANSWER_AFTER_CLOSE_PROMPT" in s, "main prompt after /close", 40)
        after = [b for b in requests[before:]]
        checks.append({"check": "/close closes the side pane; main keeps working", "ok": len(after) == 1 and "CLOSE_QUESTION" not in json.dumps(after[0].get("input", [])[-1:])})
    except Exception as error:
        checks.append({"check": "btw/split/close", "ok": False, "error": str(error)})
    screen()
    (art / "requests.json").write_text(json.dumps(requests, indent=1)[:2000000])
    (art / "outcome.json").write_text(json.dumps({"success": all(c["ok"] for c in checks), "checks": checks, "requests": len(requests)}, indent=2))
    tmux("kill-session", "-t", S)
    server.shutdown()
    success = all(c["ok"] for c in checks)
    print(json.dumps({"success": success, "checks": len(checks)}))
    print(f"ncl sessions evidence: {art}")
    sys.exit(0 if success else 1)
