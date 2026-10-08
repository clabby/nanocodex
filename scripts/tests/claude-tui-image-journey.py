#!/usr/bin/env python3
"""macOS live Claude journey through the shipped TUI and native clipboard.

Requires a signed-in nanocodex2 and Swift/AppKit. Temporarily owns the clipboard,
restoring its original contents if nobody else changes it. Uses an isolated PTY
and reload/control registry, and never restarts the Hand. Artifacts go to output/.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import termios
import time
import uuid

CLIPBOARD = r'''
import AppKit
let pb = NSPasteboard.general
let saved = (pb.pasteboardItems ?? []).map { item in
    Dictionary(uniqueKeysWithValues: (item.types).compactMap { t in item.data(forType:t).map { (t,$0) } })
}
let image = NSImage(size: NSSize(width: 640, height: 240))
image.lockFocus()
NSColor.white.setFill(); NSRect(x:0,y:0,width:640,height:240).fill()
("VIOLET 7392" as NSString).draw(at: NSPoint(x:50,y:100), withAttributes:[.font:NSFont.boldSystemFont(ofSize:64),.foregroundColor:NSColor.black])
image.unlockFocus()
let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
pb.clearContents(); pb.setData(png, forType: .png); let owned = pb.changeCount
print("ready"); fflush(stdout)
_ = readLine()
if pb.changeCount == owned {
    pb.clearContents()
    let items = saved.map { data -> NSPasteboardItem in
        let item=NSPasteboardItem(); for (type,bytes) in data { item.setData(bytes,forType:type) }; return item
    }
    pb.writeObjects(items)
}
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--expect-blocked', action='store_true')
    parser.add_argument('--queue', action='store_true')
    parser.add_argument('--output', type=Path, default=Path('output/claude-tui-images') / uuid.uuid4().hex)
    args=parser.parse_args(); out=args.output.resolve(); out.mkdir(parents=True)
    (out/'clipboard.swift').write_text(CLIPBOARD)
    env=os.environ.copy(); env.update(NANOCODEX_DISABLE_HAND='1', NANOCODEX_COMPUTER='off', CODEX_HOME=str(out/'codex'), NANOCODEX_RELOAD_DIR=str(out/'reload'), TERM='xterm-256color')
    for key in ['TMUX','TMUX_PANE','NANOCODEX2_RELOAD_EXECUTABLE']: env.pop(key,None)
    master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,180,0,0))
    child=subprocess.Popen([str(args.binary.resolve())],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=out);os.close(slave)
    captured=bytearray(); clip=None
    def pump(seconds):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            if select.select([master],[],[],min(.1,max(0,until-time.monotonic())))[0]:
                try: captured.extend(os.read(master,65536))
                except OSError: break
        (out/'terminal.ansi').write_bytes(captured)
    def wait_for(value,timeout=60):
        end=time.monotonic()+timeout
        while value.encode() not in captured:
            if time.monotonic()>end: raise AssertionError('terminal missing '+value)
            pump(.2)
    def paste(text): os.write(master,b'\x1b[200~'+text.encode()+b'\x1b[201~\r')
    try:
        wait_for('actions'); pump(5); paste('/model claude-sonnet-5-5')
        deadline=time.monotonic()+60
        while True:
            pump(.2)
            listings=json.loads(subprocess.check_output([str(args.binary.resolve()),'tui','list','--json'],env=env))
            if listings:
                response=subprocess.check_output([str(args.binary.resolve()),'tui','connect',listings[0]['instance_id'],'--stdio'],input=b'{"id":"state","method":"state.get"}\n',env=env)
                hello=json.loads(response.splitlines()[0]); state=hello['snapshot']['state']
                if state['connection']=='ready' and state['settings']['model']=='claude-sonnet-5-5' and not state['ui_blocked']: break
            assert time.monotonic()<deadline,'Claude model never ready'
        (out/'ready.json').write_text(json.dumps(hello['snapshot'],indent=2))
        clip=subprocess.Popen(['swift',str(out/'clipboard.swift')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(out/'clipboard.stderr','wb'),text=True)
        assert clip.stdout.readline().strip()=='ready','clipboard setup failed'
        if args.queue:
            paste('Write a numbered list of 200 short names for imaginary gardens. Do not use tools.')
            wait_for('queue')
        os.write(master,b'\x16');wait_for('[Image #1]')
        os.write(master,b'\x1b[200~Read the two tokens printed in this image. Reply only with the tokens.\x1b[201~')
        pump(.3);os.write(master,b'\t' if args.queue else b'\r')
        if args.expect_blocked:
            wait_for('remove image attachments'); outcome='reproduced stale Claude image rejection'
        else:
            wait_for('7392',180); wait_for('VIOLET'); outcome='Claude visually read VIOLET 7392'
            assert b'remove image attachments' not in captured
        if not args.expect_blocked:
            deadline=time.monotonic()+30
            while True:
                history=subprocess.check_output([str(args.binary.resolve()),'history',hello['snapshot']['active_session_id']],env=env)
                (out/'history.json').write_bytes(history)
                rows=json.loads(history)['data']
                answers=[r.get('event',{}).get('payload',{}).get('text') for r in rows if r.get('event',{}).get('type')=='assistant.message']
                completed=[r['event']['payload'] for r in rows if r.get('event',{}).get('type')=='run.completed']
                if 'VIOLET 7392' in answers and any(r.get('model')=='claude-sonnet-5-5' and r.get('status')=='completed' for r in completed): break
                assert time.monotonic()<deadline,'missing Claude completion receipt'
                pump(.2)
        (out/'outcome.json').write_text(json.dumps({'success':True,'outcome':outcome,'binary':str(args.binary.resolve()),'queue':args.queue},indent=2))
        print(outcome, out)
    finally:
        if clip:
            clip.communicate('\n',timeout=15)
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
        os.close(master)

if __name__=='__main__': main()
