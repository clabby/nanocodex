#!/usr/bin/env python3
"""Real Hand recorder CLI + private X11 desktop journey. No account connection.
Usage: python3 scripts/tests/hand-recording-e2e.py /absolute/path/to/nanocodex2
Requires Xvfb/openbox/xterm/xdotool, supplied by the desktop Hand environment.
"""
import json, os, pathlib, subprocess, sys, tempfile, time, signal
binary = str(pathlib.Path(sys.argv[1]).resolve())
output = pathlib.Path('output/hand-recording-e2e').resolve()
output.mkdir(parents=True, exist_ok=True)
trace=[]

def wait_for(fn, timeout=12):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            result=fn()
            if result: return result
        except (OSError,subprocess.SubprocessError,ValueError): pass
        time.sleep(.1)
    raise AssertionError('timed out waiting for expected state')

with tempfile.TemporaryDirectory(prefix='nc-recording-') as directory:
    root=pathlib.Path(directory); desktop=root/'desktop'; workspace=root/'workspace'; recordings=root/'recordings'
    workspace.mkdir(); children=[]; logs=[]
    def launch(args,env=None,name='process'):
        log=open(output/(name+'.log'),'w');logs.append(log)
        child=subprocess.Popen(args,env=env,stdout=log,stderr=log,start_new_session=True);children.append(child);return child
    def control(value):
        result=subprocess.run([binary,'hand-recording','--state-dir',str(recordings),json.dumps(value)],capture_output=True,text=True,timeout=12,check=True)
        value=json.loads(result.stdout);trace.append({'request':json.loads(result.args[-1]),'response':value});return value
    def ok(value):
        result=control(value);assert result['status']=='ok',result;return result
    def start():
        proc=launch([binary,'hand-recording','--serve','--state-dir',str(recordings),'--desktop-runtime',str(desktop)],name='recorder-'+str(len(children)))
        wait_for(lambda:(recordings/'control.sock').exists());wait_for(lambda:control({'operation':'status'}).get('status')=='ok');return proc
    def xdo(*args):
        return subprocess.check_output(['xdotool',*map(str,args)],env=env,text=True,timeout=4).strip()
    try:
        launch([binary,'__hand-desktop','--workspace',str(workspace),'--runtime',str(desktop)],name='desktop')
        wait_for(lambda:(desktop/'ready').exists())
        env=dict(os.environ,DISPLAY=(desktop/'display').read_text(),XAUTHORITY=str(desktop/'Xauthority'))
        for name in ['WAYLAND_DISPLAY','XDG_SESSION_TYPE']:env.pop(name,None)
        launch(['xterm','-T','RECORDING_SYNTHETIC_SECRET_TITLE','-geometry','65x18+40+40','-e','/bin/cat'],env,'fixture')
        window=wait_for(lambda:xdo('search','--name','RECORDING_SYNTHETIC_SECRET_TITLE').splitlines()[-1])
        xdo('windowactivate','--sync',window)
        recorder=start()
        sources=ok({'operation':'sources'})
        context=sources['sources'][0];assert context['window_id']=='x11:'+window,(context,window)
        scope={'windows':[context['window_id']],'capture_frames':False}
        record=ok({'operation':'start','scope':scope});rid=record['id']
        assert control({'operation':'start','scope':scope})['status']!='ok'
        wait_for(lambda:ok({'operation':'status','id':rid})['capture'].get('state')=='recording')
        xdo('mousemove','--window',window,50,60,'click',1,'click',5)
        xdo('type','--clearmodifiers','SYNTHETIC_SECRET_TYPED_VALUE')
        wait_for(lambda:ok({'operation':'status','id':rid})['event_count']>=4)
        paused=ok({'operation':'pause','id':rid});time.sleep(.3)
        count=ok({'operation':'status','id':rid})['event_count']
        xdo('click',1);time.sleep(.3)
        assert ok({'operation':'status','id':rid})['event_count']==count
        ok({'operation':'resume','id':rid});time.sleep(.3);xdo('click',1)
        wait_for(lambda:ok({'operation':'status','id':rid})['event_count']>count)
        # A pause/resume pair can finish between observer ticks. Native events
        # queued during that short pause must not leak into resumed evidence.
        def scroll_count():
            events=ok({'operation':'read','id':rid,'limit':200})['events']
            return sum(e['evidence'].get('event',{}).get('kind')=='scroll' for e in events)
        before_scroll=scroll_count()
        for _ in range(12):
            ok({'operation':'pause','id':rid})
            xdo('click','--delay',0,5)
            ok({'operation':'resume','id':rid})
            time.sleep(.15)
        assert scroll_count()==before_scroll, 'paused native mouse events leaked after rapid resume'
        # Switching to an excluded app must produce no content or identity for it.
        launch(['xterm','-T','EXCLUDED_SECRET_TITLE','-geometry','55x15+300+250','-e','/bin/cat'],env,'excluded')
        excluded=wait_for(lambda:xdo('search','--name','EXCLUDED_SECRET_TITLE').splitlines()[-1])
        xdo('windowactivate','--sync',excluded);xdo('mousemove','--window',excluded,50,60,'click',1);time.sleep(.35)
        wait_for(lambda:ok({'operation':'status','id':rid})['capture'].get('reason')=='scope_excluded')
        assert control({'operation':'delete','id':rid})['status']!='ok'
        stopped=ok({'operation':'stop','id':rid});assert stopped['state']=='stopped'
        export=ok({'operation':'export','id':rid,'limit':200});encoded=json.dumps(export)
        for secret in ['SYNTHETIC_SECRET_TYPED_VALUE','RECORDING_SYNTHETIC_SECRET_TITLE','EXCLUDED_SECRET_TITLE']:
            assert secret not in encoded
        assert any(e['evidence'].get('event',{}).get('kind')=='button' for e in export['events']),export
        assert any(e['evidence'].get('event',{}).get('kind')=='scroll' for e in export['events']),export
        assert control({'operation':'read','id':'../../etc/passwd'})['status']!='ok'
        assert control({'operation':'read','id':rid,'limit':201})['status']!='ok'
        (output/'recording.json').write_text(json.dumps(export,indent=2))
        # No persistent client is connected. Local sampling still runs, and a crash
        # recovers history without silently restarting observation.
        xdo('windowactivate','--sync',window)
        live=ok({'operation':'start','scope':scope});liveid=live['id'];time.sleep(.3)
        recorder.kill();recorder.wait(timeout=5)
        recorder=start()
        recovered=ok({'operation':'status','id':liveid});assert recovered['state']=='interrupted',recovered
        assert control({'operation':'resume','id':liveid})['status']!='ok'
        ok({'operation':'delete','id':liveid});ok({'operation':'delete','id':rid})
        assert ok({'operation':'list'})['recordings']==[]
        assert not list((recordings/'data').glob('rec_*'))
        (output/'result.json').write_text(json.dumps({'passed':True,'binary':binary,'journeys':['native_mouse_and_focus','no_typed_content','pause_fence','rapid_pause_resume_queue_exclusion','scope_exclusion','export_bounds','crash_recovery','deletion']},indent=2))
        print('PASS: native capture, local controls, privacy, pause/resume, crash recovery and deletion')
    finally:
        (output/'control-trace.json').write_text(json.dumps(trace,indent=2))
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=8)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=3)
        for log in logs:log.close()
