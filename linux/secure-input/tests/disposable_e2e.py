#!/usr/bin/python3
"""Destructive ROOT-only acceptance in a separately provisioned disposable Linux.
Never run on a user machine. Marker is created by the trusted sandbox controller,
not this script. Uses actual distro sudo/PAM/setuid with runtime-only synthetic
password and P256 keys; no bypass or test switch exists in release code.
"""
import base64, ctypes, hashlib, json, os, pathlib, pwd, pty, resource, secrets
import select, signal, socket, subprocess, sys, time
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = pathlib.Path(__file__).resolve().parents[1]
MARKER = pathlib.Path('/etc/nanocodex-disposable-secure-input-test')
assert os.getuid() == 0 and MARKER.read_text().strip() == 'synthetic-only-disposable', 'Dedicated disposable root required'
assert pathlib.Path('/proc/sys/fs/suid_dumpable').read_text().strip() == '0'
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0
HELPER = '/usr/libexec/nanocodex-secure-input'
ASKPASS = '/usr/libexec/nanocodex-secure-askpass'
COMMAND = '/usr/libexec/nanocodex-e2e-command'
CONFIG = '/etc/nanocodex-secure-input'
SOCKET = '/run/nanocodex-secure-input.sock'
RUN = '/run/nanocodex-secure-input'
POLICY = '/etc/sudoers.d/nanocodex-e2e'
for path in [HELPER, ASKPASS, COMMAND, CONFIG, SOCKET, RUN, POLICY]:
    assert not os.path.lexists(path), 'Fresh disposable installation required'
for uid in [998, 1000]:
    try:
        pwd.getpwuid(uid)
        raise AssertionError('Fresh disposable UID required')
    except KeyError:
        pass

def quiet(argv, **kw):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)
    assert result.returncode == 0, 'Trusted test setup failed (output intentionally redacted)'
    return result.stdout

def drop(uid):
    os.setgroups([])
    os.setgid(pwd.getpwuid(uid).pw_gid)
    os.setuid(uid)

def b64(x): return base64.b64encode(x).decode('ascii')
def un64(x): return base64.b64decode(x, validate=True)
def point(key): return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
def sign(data, key):
    r, s = utils.decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
    return b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
def approved(t, value, key):
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    recipient = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), un64(t['public_key']))
    shared = ephemeral.exchange(ec.ECDH(), recipient)
    symmetric = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=t['request_id'].encode()).derive(shared)
    nonce = os.urandom(12)
    plain = json.dumps({'request_id': t['request_id'], 'command_digest': t['command_digest'], 'value': value}, separators=(',', ':')).encode()
    e = {'operation': 'submit', 'request_id': t['request_id'], 'ephemeral_public_key': b64(point(ephemeral)), 'ciphertext': b64(nonce + AESGCM(symmetric).encrypt(nonce, plain, None))}
    e['signature'] = sign(('nanocodex-secure-sudo-v1\n' + e['request_id'] + '\n' + e['ephemeral_public_key'] + '\n' + e['ciphertext']).encode(), key)
    return e

def request_async(obj, uid=998, raw=None):
    readfd, writefd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(readfd); drop(uid)
            s = socket.socket(socket.AF_UNIX); s.settimeout(140); s.connect(SOCKET)
            s.sendall(raw if raw is not None else json.dumps(obj, separators=(',', ':')).encode() + b'\n')
            s.shutdown(socket.SHUT_WR)
            data = b''
            while True:
                chunk = s.recv(4096)
                if not chunk: break
                data += chunk
                if len(data) > 32768: raise ValueError('oversize')
            os.write(writefd, data)
            os._exit(0)
        except Exception:
            os._exit(1)
    os.close(writefd)
    return pid, readfd

def finish(req):
    pid, fd = req
    data = b''
    while True:
        part = os.read(fd, 32769)
        if not part: break
        data += part
    os.close(fd); _, status = os.waitpid(pid, 0)
    if status != 0 or not data: return None
    assert data.endswith(b'\n') and data.count(b'\n') == 1, 'Single fixed receipt required'
    assert password.encode() not in data, 'Secret appeared in receipt'
    return json.loads(data)

def request(obj, **kw): return finish(request_async(obj, **kw))
def prepare(args):
    t = request({'operation': 'prepare', 'executable': COMMAND, 'arguments': args, 'cwd': '/'})
    assert t and t.get('uid') == 1000, 'Root enrolled service998/admin1000 binding failed'
    binding = {k: t['command'][k] for k in ['arguments', 'cwd', 'executable']}; binding['uid'] = 1000
    assert t['command_digest'] == b64(hashlib.sha256(json.dumps(binding, ensure_ascii=False, separators=(',', ':')).encode()).digest())
    signature = un64(t['helper_signature']); r, s = int.from_bytes(signature[:32], 'big'), int.from_bytes(signature[32:], 'big')
    data = ('nanocodex-secure-sudo-ticket-v1\n' + t['request_id'] + '\n' + t['command_digest'] + '\n' + t['public_key'] + '\n' + str(t['expires_at']) + '\n1000').encode()
    pinned.verify(utils.encode_dss_signature(r, s), data, ec.ECDSA(hashes.SHA256()))
    return t

def ok(name): print('PASS ' + name, flush=True)
def no_endpoints(): assert not list(pathlib.Path(RUN).glob('askpass-*')), 'Askpass endpoint leaked'
def start():
    global daemon
    daemon = subprocess.Popen([HELPER], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for _ in range(100):
        if daemon.poll() is not None: raise AssertionError('Root daemon failed closed unexpectedly')
        if os.path.exists(SOCKET): return
        time.sleep(.05)
    raise AssertionError('Daemon socket timeout')
def reject_start():
    p = subprocess.run([HELPER], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    assert p.returncode == 78 and not p.stdout and not p.stderr, 'Unsafe installation was not rejected quietly'

def stop():
    global daemon
    if daemon:
        daemon.terminate(); out, err = daemon.communicate(timeout=10)
        assert not out and not err, 'Daemon produced output'
        daemon = None
    if os.path.exists(SOCKET): os.unlink(SOCKET)

backend = ec.generate_private_key(ec.SECP256R1())
password = secrets.token_urlsafe(32)  # never logged, argv, file, env, or transcript
created_users = []
daemon = None
try:
    for uid, name in [(998, 'nc-e2e-transport'), (1000, 'nc-e2e-admin')]:
        quiet(['useradd', '-M', '-u', str(uid), '-s', '/bin/sh', name]); created_users.append(name)
    quiet(['chpasswd'], input=('nc-e2e-admin:' + password + '\n').encode())
    # This policy requires PAM password auth; no NOPASSWD/no pam_permit bypass.
    pathlib.Path(POLICY).write_text('Defaults:nc-e2e-admin !requiretty, timestamp_timeout=0, passwd_tries=2\nnc-e2e-admin ALL=(root) PASSWD: ' + COMMAND + '\n')
    os.chmod(POLICY, 0o440); quiet(['visudo', '-c'])
    # Root-owned test-only executable validates actual setuid startup hardening.
    # It is compiled from the unchanged runner and removed from setuid mode below.
    fixture = ROOT / 'target/e2e-os-boundary'
    fixture.parent.mkdir(exist_ok=True)
    quiet(['cc', '-O2', '-Wall', '-Wextra', '-Werror', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', str(ROOT / 'tests/e2e-os-boundary.c'), '-o', str(fixture)])
    os.chmod(fixture, 0o4755)
    source = ROOT / 'tests/e2e-command.c'
    quiet(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(source), '-o', COMMAND]); os.chmod(COMMAND, 0o755)
    release = pathlib.Path(os.environ.get('CARGO_TARGET_DIR', ROOT / 'target')) / 'release'
    # Exercise the unmodified production installer + enrollment in a local virtual TTY.
    hashes_ = [hashlib.sha256((release / n).read_bytes()).hexdigest() for n in ['nanocodex-secure-input', 'nanocodex-secure-askpass']]
    master, slave = pty.openpty()
    p = subprocess.Popen(['bash', str(ROOT / 'install-local.sh'), str(release), *hashes_, b64(point(backend)), '998', '1000'], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave); output = b''
    while True:
        try: output += os.read(master, 4096)
        except OSError: break
    os.close(master); assert p.wait() == 0, 'Local virtual-TTY installer failed (redacted)'
    # The controller receives/pins the public enrollment result, not a Hand-learned identity.
    public = output.replace(b'\r', b'').split(b'\n')[0]
    pinned = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), un64(public))
    assert password.encode() not in output
    ok('trusted disposable local installer and independent public identity')
    # Actual installed mode, no-follow, link-count and ancestor checks.
    os.chmod(ASKPASS, 0o755)
    try: reject_start()
    finally: os.chmod(ASKPASS, 0o4755)
    configfile = pathlib.Path(CONFIG) / 'configuration.json'
    os.chmod(configfile, 0o644)
    try: reject_start()
    finally: os.chmod(configfile, 0o600)
    alias = pathlib.Path(CONFIG) / 'configuration-alias'
    os.link(configfile, alias)
    try: reject_start()
    finally: alias.unlink()
    backup = pathlib.Path(CONFIG) / 'configuration-backup'
    configfile.rename(backup); configfile.symlink_to(backup)
    try: reject_start()
    finally: configfile.unlink(); backup.rename(configfile)
    oldmode = pathlib.Path('/usr/libexec').stat().st_mode & 0o7777
    os.chmod('/usr/libexec', 0o777)
    try: reject_start()
    finally: os.chmod('/usr/libexec', oldmode)
    uninstalled = subprocess.run([str(release / 'nanocodex-secure-input')], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert uninstalled.returncode == 78 and not uninstalled.stdout and not uninstalled.stderr
    ok('installed askpass/config modes symlink hardlink mutable ancestors and inode checks')
    start()
    # Actual root identity/config are inaccessible from both unprivileged UIDs.
    for uid in [998, 1000]:
        pid = os.fork()
        if pid == 0:
            drop(uid)
            for path in [str(configfile), '/proc/' + str(daemon.pid) + '/mem']:
                try: fd = os.open(path, os.O_RDONLY); os.close(fd); os._exit(1)
                except PermissionError: pass
            os._exit(0)
        _, status = os.waitpid(pid, 0); assert status == 0, 'Unprivileged secret boundary failed'
    assert password.encode() not in pathlib.Path('/proc/' + str(daemon.pid) + '/cmdline').read_bytes()
    assert password.encode() not in pathlib.Path('/proc/' + str(daemon.pid) + '/environ').read_bytes()
    ok('transport/admin cannot read root configuration or memory; argv/env secret free')
    assert request({'operation':'cancel','request_id':'x'}, uid=1000) is None
    assert request({'operation':'prepare','executable':COMMAND,'arguments':[],'cwd':'/','uid':1000}) == {'status':'rejected'}
    ok('kernel transport UID and caller-selected UID rejection')
    t = prepare(['success'])
    e = approved(t, password, backend)
    a, b = request_async(e), request_async(e)
    results = [finish(a), finish(b)]
    assert sum(r is not None and r.get('status') == 'completed' and r.get('exit_code') == 0 for r in results) == 1, 'Real PAM success/one-use failed'
    assert sum(r == {'status':'rejected'} for r in results) == 1
    no_endpoints(); ok('real setuid sudo/PAM/crypto success concurrent replay and no output')
    t = prepare(['success']); r = request(approved(t, secrets.token_urlsafe(32), backend))
    assert r and r.get('status') == 'completed' and r.get('exit_code') == 1, 'Wrong password must fail PAM'
    assert request(approved(t, password, backend)) == {'status':'rejected'}
    no_endpoints(); ok('wrong password and one-shot retry rejection')
    t = prepare(['success']); assert request({'operation':'cancel','request_id':t['request_id']})['status'] == 'cancelled'
    assert request(approved(t, password, backend)) == {'status':'rejected'}
    t = prepare(['success']); wrongkey = ec.generate_private_key(ec.SECP256R1())
    assert request(approved(t, password, wrongkey)) == {'status':'rejected'}
    assert request(approved(t, password, backend))['exit_code'] == 0
    ok('distinct UID cancellation and wrong backend key')
    t = prepare(['success']); stop(); start()
    assert request(approved(t, password, backend)) == {'status':'rejected'}
    assert request(None, raw=b'{"operation":"cancel","request_id":"x"}\n{}\n') == {'status':'rejected'}
    ok('daemon restart and trailing-frame fail closed')
    # Actual installed setuid askpass cannot serve an ordinary non-sudo parent.
    result = subprocess.run([ASKPASS], preexec_fn=lambda: drop(1000), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert result.returncode != 0 and not result.stdout and not result.stderr
    quiet([str(ROOT / 'target/e2e-os-boundary')])
    no_endpoints(); ok('fake parent and actual memory/core/UID-transition boundaries')
    # Approved command deliberately exceeds release timeout: no reduced test timeout.
    t = prepare(['timeout']); begin = time.monotonic(); r = request(approved(t, password, backend))
    assert r and r.get('status') == 'outcome_unknown' and 119 <= time.monotonic() - begin < 135, 'Release timeout/receipt failed'
    no_endpoints(); assert request(approved(t, password, backend)) == {'status':'rejected'}
    # A stale socket is not enough: no live approved command may survive timeout.
    for proc in pathlib.Path('/proc').glob('[0-9]*/exe'):
        try: target = os.readlink(proc)
        except OSError: continue
        assert target != COMMAND, 'Live approved command survived timeout'
    ok('120-second timeout process-group cleanup and nonretryable receipt')
    # Admission budget is actual enforced transport policy, not just a unit test.
    stop(); start()
    for _ in range(24): assert request({'operation':'cancel','request_id':'absent'}) == {'status':'rejected'}
    assert request({'operation':'cancel','request_id':'absent'}) is None
    ok('24 admissions per transport UID per minute cap')
    # Blocked framing cannot be extended by single byte progress.
    stop(); start()
    readfd, writefd = os.pipe(); pid = os.fork()
    if pid == 0:
        os.close(readfd); drop(998); s = socket.socket(socket.AF_UNIX); s.connect(SOCKET)
        begin = time.monotonic(); s.sendall(b'{')
        try:
            while time.monotonic() - begin < 8:
                time.sleep(.7); s.sendall(b' ')
        except OSError: pass
        os.write(writefd, str(time.monotonic() - begin).encode()); os._exit(0)
    os.close(writefd); elapsed = float(os.read(readfd, 100)); os.close(readfd); os.waitpid(pid, 0)
    assert 4 <= elapsed < 7, 'Slowloris deadline failed'
    ok('absolute slowloris framing deadline')
    stop(); print('RESULT synthetic disposable Linux OS acceptance passed', flush=True)
finally:
    stop()
    import shutil
    for path in [HELPER, ASKPASS, COMMAND, SOCKET, POLICY]:
        if os.path.lexists(path): os.unlink(path)
    for path in [CONFIG, RUN]:
        if os.path.exists(path): shutil.rmtree(path)
    for name in reversed(created_users): subprocess.run(['userdel', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fixture = ROOT / 'target/e2e-os-boundary'
    if fixture.exists(): os.chmod(fixture, 0o755)
