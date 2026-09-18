# Isolated fixture only. Never point this verifier at a human desktop.
import json,socket,os,subprocess,time
p='background-cua/';env=json.load(open(p+'fixture-env.json'))
def ctl(*args):return json.loads(subprocess.check_output(['python3',p+'hyprctl-fixture.py',*args,'-j']))
pid=json.load(open(p+'blender-hypr-baseline-proof.json'))['pid'];w=next(x for x in ctl('clients') if x['pid']==pid)
s=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);s.settimeout(3);s.connect(env['XDG_RUNTIME_DIR']+'/hypr/'+env['HYPRLAND_INSTANCE_SIGNATURE']+'/cua-input-v3.sock')
def req(q):s.send(q.encode());r=json.loads(s.recv(16384));assert r.get('ok'),r;return r
front=ctl('activewindow')['pid'];cursor=ctl('cursorpos')
req('HELLO');req('CLAIM');t=req(f"TARGET {pid} {w['address'][2:]} 8")
r=req(f"DRAG 1 {t['target']} {t['revision']} 120 160 240 200 2000 274 1");assert r.get('phase')=='started',r
time.sleep(.05);s.close();time.sleep(.1)
status=ctl('cua:status');assert all(not x['held_button'] and not x['held_keys'] and not x['drag_active'] for x in status['input']['lanes']),status
assert ctl('activewindow')['pid']==front;assert ctl('cursorpos')==cursor
json.dump({'status':'passed','foreground_pid':front,'cursor':cursor,'lanes':status['input']['lanes']},open(p+'cancel-proof.json','w'),indent=2)
print('PASS disconnect during Shift-middle drag: no held buttons or keys; foreground/cursor unchanged')
