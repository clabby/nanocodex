#!/usr/bin/env python3
"""Real Linux installer, systemd, screen catalog and private IPC journey.
Run as a Docker-authorized user. Only the account HTTP/WS service is a fixture.
"""
import argparse, json, pathlib, select, subprocess, time, uuid

parser = argparse.ArgumentParser()
parser.add_argument('--bin-dir', required=True, type=pathlib.Path)
parser.add_argument('--image', default='nanocodex-installer-journey:20261007')
parser.add_argument('--output', required=True, type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
name = 'nanocodex-installer-test-' + uuid.uuid4().hex[:10]
records = []
key = 'ncx_live_' + 'a'*12 + '_' + 'b'*43
origin = 'http://127.0.0.1:8765'

def run(argv, *, data=None, ok=True, timeout=120):
    start = time.monotonic()
    p = subprocess.run(argv, input=data, text=True, capture_output=True, timeout=timeout)
    records.append(dict(command=argv, ms=round((time.monotonic()-start)*1000, 2), code=p.returncode, stdout=p.stdout, stderr=p.stderr))
    if ok and p.returncode: raise AssertionError(f'{argv}: {p.stdout}\n{p.stderr}')
    return p

def inside(*argv, **kwargs): return run(['docker','exec',*(['-i'] if kwargs.get('data') is not None else []),name,*argv], **kwargs)
def user(*argv, home='/home/ubuntu', **kwargs):
    return inside('runuser','-u','ubuntu','--','env',f'HOME={home}',f'NANOCODEX_MANAGED_URL={origin}',*argv, **kwargs)
def fetch(path, **kwargs): return inside('node','-e',"fetch(process.argv[1]).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))", origin+path, **kwargs)
def public(path): return json.loads(fetch(path).stdout)
def pid(): return inside('systemctl','show','nanocodex-hand.service','-p','MainPID','--value').stdout.strip()
def wait(predicate, seconds=30):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        value=predicate()
        if value: return value
        time.sleep(.05)
    raise AssertionError('timed out waiting for observable readiness')

clients=[]
try:
    run(['docker','run','--detach','--privileged','--cgroupns=host','--name',name,
         '--tmpfs','/run','--tmpfs','/run/lock','--mount',f'type=bind,src={args.bin_dir.resolve()},dst=/candidate,readonly',
         '--mount','type=bind,src=/sys/fs/cgroup,dst=/sys/fs/cgroup',args.image])
    # Image libraries keep the executable runnable, but the actual installer
    # must supply the missing display and encoder through its background job.
    inside('apt-get','remove','--yes','--no-auto-remove','ffmpeg','xvfb')
    for binary in ['ffmpeg','Xvfb']:
        assert inside('sh','-c','command -v '+binary,ok=False).returncode != 0
    inside('mkdir','-p','/fixture/bin','/fixture/home-a','/fixture/home-b')
    for binary in ['nanocodex','nanocodex2']:
        inside('cp','/candidate/'+binary,'/fixture/bin/'+binary)
        inside('chmod','755','/fixture/bin/'+binary)
    run(['docker','cp',str(root/'scripts/fixtures/linux-installer/cloud.cjs'),f'{name}:/fixture/cloud.cjs'])
    inside('sh','-c',"printf 'ubuntu ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/ubuntu-fixture; chmod 440 /etc/sudoers.d/ubuntu-fixture; chown -R ubuntu:ubuntu /fixture/home-a /fixture/home-b")
    inside('systemd-run','--unit=fixture-account','/usr/bin/node','/fixture/cloud.cjs')
    wait(lambda: fetch('/evidence',ok=False).returncode==0)
    assert inside('test','-e','/opt/nanocodex/account.env',ok=False).returncode != 0
    # Public bootstrap schedules updates before Hand preparation. A headless
    # login has no session bus; that must not prevent the actual install flow.
    updater=['env','-u','DBUS_SESSION_BUS_ADDRESS','-u','XDG_RUNTIME_DIR',
             '/fixture/bin/nanocodex','update','--auto']
    automatic=user(*updater,'enable','--nightly')
    assert 'timer not started' in automatic.stdout, automatic.stdout
    updater_status=user(*updater,'status').stdout
    assert 'enabled=true' in updater_status and 'unavailable' in updater_status, updater_status
    user(*updater,'disable')
    assert 'configured=false' in user(*updater,'status').stdout
    prepared=user('/fixture/bin/nanocodex','hand','install','--prepare','--executable','/fixture/bin/nanocodex2')
    record=json.loads(inside('cat','/opt/nanocodex/installation.json').stdout)
    assert record['pending_login'] is True and record['service_uid']==1000, record
    assert inside('test','-e','/opt/nanocodex/account.env',ok=False).returncode != 0
    assert public('/evidence')['live']==[], 'logged-out preparation published a Hand'
    preparation_state=inside('systemctl','show','nanocodex-hand-components.service','-p','ActiveState','--value').stdout.strip()
    assert preparation_state in ['activating','active'], preparation_state
    wait(lambda: inside('systemctl','show','nanocodex-hand-components.service','-p','ActiveState','--value').stdout.strip()=='active', seconds=300)
    inside('sh','-c','command -v ffmpeg && command -v Xvfb')
    account=json.dumps({'version':1,'accounts':{origin:{'api_key':key}}})
    inside('sh','-c',"umask 077; cat >/fixture/home-a/account.json; chown ubuntu:ubuntu /fixture/home-a/account.json",data=account)
    connect=['/fixture/bin/nanocodex','hand','connect','--account-file','/fixture/home-a/account.json','--managed-url',origin]
    # Exact saved login activation must ignore another ambient API key.
    user('env','NANOCODEX_API_KEY=ncx_live_wrong_ambient',*connect, home='/fixture/home-a')
    record=json.loads(inside('cat','/opt/nanocodex/installation.json').stdout)
    assert record['pending_login'] is False and record['service_uid']==1000
    original_pid=pid(); assert int(original_pid)>0
    evidence=public('/evidence')
    machine=next(p['catalog']['machines'][0] for p in evidence['live'] if p.get('catalog',{}).get('machines'))
    screens=[p['catalog'] for p in evidence['live'] if p.get('catalog',{}).get('surfaces')]
    assert len(screens)==1 and screens[0]['machine_id']==machine['id']
    assert screens[0]['surfaces'][0]['controllable'] is True
    assert inside('stat','-c','%a','/opt/nanocodex/account.env').stdout.strip()=='600'
    assert user('test','-r','/opt/nanocodex/account.env',ok=False).returncode!=0
    for home in ['/fixture/home-a','/fixture/home-b']:
        cmd=['docker','exec','-i',name,'runuser','-u','ubuntu','--','env',f'HOME={home}',f'NANOCODEX_MANAGED_URL={origin}',
             'NANOCODEX_ACCOUNT_FILE=/fixture/home-a/account.json','/fixture/bin/nanocodex2','__device-hand','--parent-pipe']
        p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        clients.append(p)
        assert select.select([p.stdout],[],[],15)[0], 'local observer did not connect'
        status=json.loads(p.stdout.readline()); records.append({'observer':home,'status':status})
        assert status['machine']['id']==machine['id'] and status['status']=='connected',status
    for p in clients:
        stdout,stderr=p.communicate('',timeout=15)
        assert p.returncode==0,(stdout,stderr)
    clients=[]
    assert pid()==original_pid, 'client exit stopped/restarted the daemon'
    user(*connect,home='/fixture/home-b')
    user('/fixture/bin/nanocodex','hand','install','--prepare')
    assert pid()==original_pid, 'idempotent setup restarted the daemon'
    final=public('/evidence')
    publishers=[e for e in final['events'] if e['type']=='connected' and e['path'].endswith('/tool-host')]
    assert len(publishers)==1, publishers
    assert not [e for e in final['events'] if e['type']=='rejected'], final
    summary={'result':'PASS','machine_id':machine['id'],'daemon_pid':original_pid,'account_publishers':len(publishers),
             'screen_catalogs':len(screens),'service_uid':record['service_uid'],'observers':2,
             'logged_out_background_components':True,'logged_out_updater_without_session_bus':True,'initial_components_state':preparation_state,
             'missing_desktop_packages_installed':True,'private_credentials':True,'ambient_key_ignored':True,
             'daemon_survives_clients':True,'idempotent_setup':True}
    (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    (out/'account-events.json').write_text(json.dumps(final,indent=2)+'\n')
    print(json.dumps(summary))
finally:
    for p in clients:
        p.terminate()
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired: p.kill()
    try:
        evidence=fetch('/evidence',ok=False)
        (out/'final-evidence.json').write_text(evidence.stdout)
        status=inside('sh','-c',"find /srv/nanocodex/.nanocodex -name status.json -exec cat {} \\;",ok=False)
        (out/'final-status.json').write_text(status.stdout)
        logs=inside('journalctl','-u','nanocodex-hand.service','-u','nanocodex-hand-components.service','--no-pager','-n','120',ok=False)
        (out/'service.log').write_text(logs.stdout+logs.stderr)
    finally:
        run(['docker','rm','--force',name],ok=False)
        (out/'commands.json').write_text(json.dumps(records,indent=2)+'\n')
