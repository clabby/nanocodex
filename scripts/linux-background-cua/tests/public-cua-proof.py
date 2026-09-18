# Isolated fixture only. Never point this verifier at a human desktop.
import json,subprocess,os,time,threading
from pathlib import Path
p=Path('background-cua');env=os.environ.copy();env.update(json.load(open(p/'fixture-env.json')));env['NANOCODEX_COMPUTER_BACKGROUND']='hyprland';env['NANOCODEX_HYPRLAND_CAPTURE']=str((p/'source/scripts/linux-background-cua/capture/target/debug/nanocodex-hyprland-capture').resolve())
proc=subprocess.Popen([str(p/'source/crates/experimental/nanocodex-computer/runtime/target/debug/nanocodex-computer'),'--allow-native-control','serve'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(p/'public-runtime-stderr.log','w'),text=True)
id=0;receipts=[]
def rpc(method,params):
 global id
 id+=1;t=time.monotonic();proc.stdin.write(json.dumps({'jsonrpc':'2.0','id':id,'method':method,'params':params})+'\n');proc.stdin.flush()
 while True:
  line=proc.stdout.readline()
  if not line:raise RuntimeError('companion exited')
  r=json.loads(line)
  if r.get('id')==id:break
 receipts.append({'method':method,'ms':round((time.monotonic()-t)*1000,2),'result':r})
 if 'error' in r:raise RuntimeError(r)
 return r.get('result')
def js(code):
 r=rpc('tools/call',{'name':'js','arguments':{'code':code},'_meta':{'x-codex-turn-metadata':{'thread_id':'background-proof','call_id':str(id)}}})
 if r.get('isError'):raise RuntimeError(r)
 return r
def ctl(*a):return json.loads(subprocess.check_output(['python3',str(p/'hyprctl-fixture.py'),*a,'-j']))
def fixture():return json.load(open(p/'blender-hypr-baseline-proof.json'))
try:
 rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'background-validation','version':'1'}})
 pid=fixture()['pid'];js(f'var app = await cua.getApp("{pid}");')
 js('await nodeRepl.emitImage(await app.getScreenshot());')
 before=fixture();front=ctl('activewindow');cursor=ctl('cursorpos');text=json.load(open(p/'foreground-current.json'))['text']
 def typing():
  with open(p/'primary2-keys.fifo','w') as f:
   for _ in range(8):f.write('17\n');f.flush();time.sleep(.05)
 t=threading.Thread(target=typing);t.start()
 js('await app.click([140,160]); await app.pressKey("a"); await app.pressKey("g"); await app.pressKey("x"); await app.pressKey("1"); await app.pressKey("enter");')
 t.join();time.sleep(.15);after=fixture();assert abs(after['cube'][0]-before['cube'][0]-1)<.001,(before,after)
 assert ctl('activewindow')['pid']==front['pid'];assert ctl('cursorpos')==cursor
 assert json.load(open(p/'foreground-current.json'))['text']==text+'w'*8
 rotation=fixture()['views'];js('await app.drag([180,180],[260,230],{mouseButton:"middle"});');time.sleep(.15)
 assert fixture()['views']!=rotation,'middle drag did not rotate viewport'
 location=fixture()['view_locations'];t=threading.Thread(target=typing);t.start();js('await app.drag([180,180],[220,200],{mouseButton:"middle",modifiers:["shift"]});');t.join();time.sleep(.1);assert json.load(open(p/'foreground-current.json'))['text']==text+'w'*16;assert fixture()['view_locations']!=location,'Shift-middle did not pan'
 js('await nodeRepl.emitImage(await app.getScreenshot());')
 assert ctl('activewindow')['pid']==front['pid'];assert ctl('cursorpos')==cursor
 json.dump({'status':'passed','before':before,'after':after,'rotation_before':rotation,'rotation_after':fixture()['views'],'pan_before':location,'pan_after':fixture()['view_locations'],'foreground_pid':front['pid'],'cursor':cursor,'foreground_text_before':text,'foreground_text_after':json.load(open(p/'foreground-current.json'))['text'],'latencies_ms':[r['ms'] for r in receipts]},open(p/'public-proof-summary.json','w'),indent=2)
 print('PASS public CUA: simultaneous primary typing, cube transform, middle orbit; Shift-middle pan verified; foreground/cursor unchanged')
finally:
 # Keep image bytes out of text receipts, retain actual PNG evidence separately.
 import base64
 for n,receipt in enumerate(receipts):
  for block in receipt['result'].get('result',{}).get('content',[]):
   if block.get('type')=='image':(p/f'public-capture-{n}.png').write_bytes(base64.b64decode(block.pop('data')));block['saved']=f'public-capture-{n}.png'
 json.dump(receipts,open(p/'public-cua-receipts.json','w'),indent=2)
 proc.terminate();proc.wait(timeout=5)
