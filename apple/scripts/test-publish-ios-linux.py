#!/usr/bin/env python3
"""Local CLI refusal and persistent asset policy journeys; no network writes.

Real CLI refusal checks use production validation. The successful OTA policy
journey substitutes only the unavailable real Apple-signed/device input boundary
inside a child process. It is explicitly not signing, trust or device evidence.
"""
import argparse
import datetime as dt
import copy
import plistlib
import zipfile
from unittest.mock import patch
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT/'apple/scripts/publish-ios-linux.py'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, default=ROOT/'output/ios-linux-local-publish')
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
trace = ['Synthetic fixtures and mocked signing boundary only. No Apple/device validation or network writes.']


def tree(path):
    return {p.relative_to(path).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in path.rglob('*') if p.is_file()}


try:
    with tempfile.TemporaryDirectory(prefix='linux-ota-journey-') as work:
        temp = Path(work)
        assets = temp/'assets'; assets.mkdir()
        ipa = temp/'synthetic.ipa'; ipa.write_bytes(b'synthetic unsigned fixture')
        baseline = temp/'baseline.json'
        device = temp/'device.json'
        signing = Path(str(ipa)+'.signing.json')
        # Actual manifest/persistent staging implementation, not a stub.
        sys.path.insert(0, str(SCRIPT.parent))
        import importlib.util
        spec = importlib.util.spec_from_file_location('publisher', SCRIPT)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        old = temp/'old.ipa'; old.write_bytes(b'synthetic old fixture')
        mod.ota.prepare(old, assets, '1.0.0', '10', None)

        def snapshot():
            baseline.write_text(json.dumps({'status':'complete-live-snapshot', 'origin':mod.ota.ORIGIN,
                'observed_at':'2026-01-01T00:00:00Z', 'observer':'synthetic test operator', 'files':tree(assets)}))

        snapshot()
        sha = hashlib.sha256(ipa.read_bytes()).hexdigest()
        signing.write_text(json.dumps({'status':'signed-structurally-checked', 'sha256':sha,
            'zsign_revision':mod.sign.ZSIGN_REVISION, 'apple_device_installation_verified':False,
            'signing_certificate_sha256':'0'*64}))
        base = ['--ipa',str(ipa),'--assets-dir',str(assets),'--baseline-receipt',str(baseline)]

        def cli(label, extra=(), expected=None, mock=None, ok=False):
            before = tree(assets)
            command = [sys.executable, str(SCRIPT), *base, *extra]
            if mock:
                # Inject exactly one unavailable external input boundary; never
                # install this adapter or add a bypass flag to production CLI.
                adapter = ('import importlib.util,sys;'
                    f's=importlib.util.spec_from_file_location("p",{str(SCRIPT)!r});'
                    'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                    f'm.validate=lambda *a: {mock!r};m.main()')
                command = [sys.executable,'-c',adapter,*base,*extra]
            result = subprocess.run(command, text=True, capture_output=True)
            message = result.stdout + result.stderr
            trace.append(label+'\n'+message.replace(work,'$TEST_DIR')+'exit='+str(result.returncode))
            assert (result.returncode == 0) == ok, message
            if expected: assert expected in message, message
            if not ok: assert tree(assets) == before, label+' mutated assets on refusal'
            return message

        cli('existing upload destination refused', ['--upload-dir',str(assets)], 'new non-symlink path')
        cli('upload tree nested inside archive refused', ['--upload-dir',str(assets/'fresh-upload')], 'separate from archival assets')
        cli('deploy requires explicit user exact-SHA attestation', ['--deploy'], 'requires a real user device-test receipt')
        cli('attestation cannot be repurposed as offline validation', ['--user-tested-sha256',sha], 'only valid with --deploy')
        cli('deploy rejects wrong user SHA', ['--deploy','--device-test-receipt',str(device),
            '--user-tested-sha256','0'*64], 'must match exactly this signed IPA')
        signing.unlink()
        cli('unsigned input', expected='Receipt must be a regular')
        signing.write_text(json.dumps({'status':'signed-structurally-checked','sha256':'0'*64}))
        cli('hash-mismatched signing receipt', expected='IPA hash mismatch')
        signing.write_text(json.dumps({'status':'signed-structurally-checked','sha256':sha,'zsign_revision':'bad'}))
        cli('wrong signer revision', expected='pinned Linux zsign revision')
        signing.write_text(json.dumps({'status':'signed-structurally-checked','sha256':sha,
            'zsign_revision':mod.sign.ZSIGN_REVISION,'apple_device_installation_verified':True}))
        cli('invented device claim inside signing receipt', expected='must not misrepresent')
        signing.write_text(json.dumps({'status':'signed-structurally-checked','sha256':sha,
            'zsign_revision':mod.sign.ZSIGN_REVISION,'apple_device_installation_verified':False,
            'signing_certificate_sha256':'0'*64}))
        cli('synthetic malformed IPA rejected', expected='BadZipFile')
        device.write_text(json.dumps({'status':'device-tested','sha256':'0'*64}))
        cli('wrong device observation hash', ['--device-test-receipt',str(device)], 'device receipt IPA hash mismatch')
        device.write_text(json.dumps({'status':'device-tested','sha256':sha,'tested_at':'2026-01-01T00:00:00Z',
            'observer':'synthetic','device_udid':'synthetic','observations':'synthetic fixture'}))
        cli('synthetic observations rejected', ['--device-test-receipt',str(device)], 'Synthetic/test observations')
        # Artificial observation shape only: this is NOT an actual USER attestation.
        observation={'status':'device-tested','sha256':sha,'tested_at':'2026-01-01T00:00:00Z',
            'observer':'Policy unit','device_udid':'POLICY-UNIT','observations':'Policy boundary only; not device evidence.',
            'checks':{name:True for name in ('installation','app_launch','share_extension','widgets','app_groups','voice','app_intents')}}
        device.write_text(json.dumps(observation))
        cli('even complete artificial attestation shape cannot enable network publication',
            ['--deploy','--device-test-receipt',str(device),'--user-tested-sha256',sha], 'Automatic deployment disabled')
        broken=copy.deepcopy(observation);broken['checks']['app_intents']=False;device.write_text(json.dumps(broken))
        cli('unconfirmed App Intents blocks deploy', ['--deploy','--device-test-receipt',str(device),
            '--user-tested-sha256',sha], 'Real-device check unconfirmed: app_intents')
        broken=copy.deepcopy(observation);broken['checks']=[];device.write_text(json.dumps(broken))
        cli('malformed observation checks fail closed', ['--device-test-receipt',str(device)], 'checks must be an object')
        broken=copy.deepcopy(observation);broken['tested_at']='2999-01-01T00:00:00Z';device.write_text(json.dumps(broken))
        cli('future device observation refused', ['--device-test-receipt',str(device)], 'dated in the future')
        broken=copy.deepcopy(observation);broken['tested_at']='2026-01-01Z';device.write_text(json.dumps(broken))
        cli('date-only timestamp refused', ['--device-test-receipt',str(device)], 'absolute UTC timestamp')
        link=temp/'linked';link.symlink_to(assets, target_is_directory=True)
        cli('symlink ancestor path refused', ['--assets-dir',str(link)], 'Symlinks are forbidden')
        link2=temp/'linked-input';link2.symlink_to(temp, target_is_directory=True)
        cli('symlink IPA ancestor refused', ['--ipa',str(link2/ipa.name)], 'Symlinks are forbidden')
        signing.write_text('[]')
        cli('non-object signing receipt refused', expected='Receipt must be a JSON object.')
        signing.write_text(json.dumps({'status':'signed-structurally-checked','sha256':sha,
            'zsign_revision':mod.sign.ZSIGN_REVISION,'apple_device_installation_verified':False,
            'signing_certificate_sha256':'0'*64}))
        data=json.loads(baseline.read_text());data['files']['latest.json']='0'*64;baseline.write_text(json.dumps(data))
        cli('tampered/incomplete baseline', expected='hash-match every persistent asset')
        snapshot()
        cli('fresh feed cannot overwrite existing live site', ['--assets-dir',str(temp/'missing')], 'Existing complete persistent')
        # A hash-matched operator baseline cannot hide broken archived history.
        saved=(assets/'builds/10/sha256.txt').read_bytes()
        (assets/'builds/10/sha256.txt').write_text('invalid checksum');snapshot()
        cli('inconsistent historical checksum refused', mock=('1.1.0','11'), expected='inconsistent immutable history')
        (assets/'builds/10/sha256.txt').write_bytes(saved);snapshot()
        saved=(assets/'latest.json').read_bytes()
        broken=json.loads(saved);broken['build']='9';broken['manifest_url']=f'{mod.ota.ORIGIN}/builds/9/manifest.plist'
        (assets/'latest.json').write_text(json.dumps(broken));snapshot()
        cli('latest behind immutable history refused', mock=('1.1.0','11'), expected='history is newer than latest')
        (assets/'latest.json').write_bytes(saved);snapshot()
        # Narrow policy integration check with synthetic candidate validation mock.
        before_old = tree(assets/'builds/10')
        cli('offline next-build staging with mock signed boundary', mock=('1.1.0','11'), ok=True, expected='Offline staging only')
        assert tree(assets/'builds/10') == before_old
        assert (assets/'builds/11/Nanocodex.ipa').read_bytes() == ipa.read_bytes()
        latest=json.loads((assets/'latest.json').read_text()); assert latest['build']=='11'
        snapshot()
        cli('idempotent same immutable build', mock=('1.1.0','11'), ok=True)
        snapshot()
        cli('downgrade build refusal', mock=('1.1.0','9'), expected='downgrade latest')
        cli('downgrade version refusal', mock=('0.9.0','12'), expected='version downgrade')
        ipa.write_bytes(b'changed synthetic bytes')
        cli('immutable build overwrite refusal', mock=('1.1.0','11'), expected='immutable checksum differs')
        # Actual chunk helper through the public publisher --upload-dir path.
        # Only signed-input validation remains mocked; all copying/chunking,
        # immutable policy, preservation and CLI transport are real.
        ipa.write_bytes(b'A'*(49*1024*1024)+b'end')
        upload = temp/'upload'
        snapshot()
        previous10, previous11 = tree(assets/'builds/10'), tree(assets/'builds/11')
        cli('49MiB candidate through real chunk-helper CLI; signed-input boundary mocked',
            ['--upload-dir',str(upload)], mock=('1.2.0','12'), ok=True,
            expected='Separate all-history chunked upload tree prepared')
        assert tree(assets/'builds/10') == previous10
        assert tree(assets/'builds/11') == previous11
        assert (assets/'builds/12/Nanocodex.ipa').read_bytes() == ipa.read_bytes()
        assert not (upload/'builds/12/Nanocodex.ipa').exists()
        meta=json.loads((upload/'builds/12/Nanocodex.ipa.chunks.json').read_text())
        assert meta['sha256']==hashlib.sha256(ipa.read_bytes()).hexdigest()
        assert len(meta['chunks'])==3
        reconstructed=hashlib.sha256()
        for part in meta['chunks']:
            path=upload/part['path'].lstrip('/')
            assert path.stat().st_size<=24*1024*1024
            data=path.read_bytes()
            assert hashlib.sha256(data).hexdigest()==part['sha256']
            reconstructed.update(data)
        assert reconstructed.hexdigest()==meta['sha256']
        assert all(p.stat().st_size<=24*1024*1024 for p in upload.rglob('*') if p.is_file())
        for historical in ('10','11'):
            full=assets/'builds'/historical/'Nanocodex.ipa'
            assert not (upload/'builds'/historical/'Nanocodex.ipa').exists()
            sidecar=json.loads((upload/'builds'/historical/'Nanocodex.ipa.chunks.json').read_text())
            assert len(sidecar['chunks'])==1
            data=(upload/sidecar['chunks'][0]['path'].lstrip('/')).read_bytes()
            assert data==full.read_bytes()
            assert hashlib.sha256(data).hexdigest()==sidecar['sha256']
        trace.append('PASS: historical tiny IPAs also use authenticated single-chunk upload metadata; archive bytes remain unchanged.')
        assert (upload/'builds/12/manifest.plist').read_bytes()==(assets/'builds/12/manifest.plist').read_bytes()
        snapshot()
        cli('existing chunked output never overwritten', ['--upload-dir',str(upload)], expected='new non-symlink path')
        trace.append('PASS: actual helper generated 3 <=24MiB chunks, full SHA reconstructed; archived large IPA/history retained, upload large IPA absent, prior small builds/manifests retained.')
        # Real CMS chain refusal: default trust paths must not bypass the pinned
        # Apple root. Disposable self-issued material only, never Apple keys.
        untrusted = temp/'untrusted-root';untrusted.mkdir(mode=0o700)
        def openssl(*arguments):
            result=subprocess.run(['openssl',*map(str,arguments)],capture_output=True)
            assert result.returncode==0, 'Synthetic CMS setup failed.'
        openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout',untrusted/'key.pem',
            '-out',untrusted/'root.pem','-days','1','-subj','/CN=Synthetic untrusted profile signer')
        (untrusted/'content').write_bytes(b'Synthetic profile trust-boundary payload')
        openssl('cms','-sign','-binary','-nodetach','-in',untrusted/'content',
            '-signer',untrusted/'root.pem','-inkey',untrusted/'key.pem',
            '-outform','DER','-out',untrusted/'profile.cms')
        trust=untrusted/'trust';trust.mkdir();(trust/'root.pem').write_bytes((untrusted/'root.pem').read_bytes())
        openssl('rehash',trust)
        import os
        with patch.dict(os.environ,{'SSL_CERT_DIR':str(trust),'SSL_CERT_FILE':str(untrusted/'root.pem')}):
            try: mod.verified_profile_content(untrusted/'profile.cms')
            except ValueError as error:
                assert 'pinned Apple Root CA' in str(error)
            else: raise AssertionError('Default trust store bypassed the pinned Apple profile anchor.')
        trace.append('PASS: real synthetic CMS rooted in overridden default trust directory is rejected by exclusive pinned Apple profile anchor.')
        # Production profile guards exercised with synthetic decoded CMS only.
        # Never open private Apple inputs or equate these unit checks with trust.
        now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        cert=b'policy-unit-certificate';certsha=hashlib.sha256(cert).hexdigest()
        profiles={}
        for bundle in mod.sign.IDS:
            profiles[bundle]={'ApplicationIdentifierPrefix':['TEAM'], 'TeamIdentifier':['TEAM'],
                'CreationDate':(now-dt.timedelta(days=1)).replace(tzinfo=None),
                'ExpirationDate':(now+dt.timedelta(days=30)).replace(tzinfo=None),
                'DeveloperCertificates':[cert], 'ProvisionedDevices':['POLICY-UNIT'], 'UUID':bundle,
                'Entitlements':{'application-identifier':'TEAM.'+bundle, 'com.apple.developer.team-identifier':'TEAM',
                    'com.apple.security.application-groups':[mod.sign.GROUP]}}
        def guard(label, fn, expected):
            try: fn()
            except ValueError as error:
                assert expected in str(error), str(error)
                trace.append('PASS unit '+label+': '+str(error))
            else: raise AssertionError(label+' did not refuse')
        def profile_call(bundle, value):
            with patch.object(mod.sign, 'run', return_value=plistlib.dumps(value)):
                return mod.sign.profile(temp/'not-a-real-profile',bundle,cert,now)
        for bundle in mod.sign.IDS:
            assert profile_call(bundle,profiles[bundle])['UUID']==bundle
            expired=copy.deepcopy(profiles[bundle]);expired['ExpirationDate']=(now-dt.timedelta(seconds=1)).replace(tzinfo=None)
            guard('expired '+bundle,lambda:profile_call(bundle,expired),'Expired or undated profile')
            missing=copy.deepcopy(profiles[bundle]);missing['Entitlements']['application-identifier']='TEAM.wrong'
            guard('wrong entitlement '+bundle,lambda:profile_call(bundle,missing),'exact application-identifier')
            wrong=copy.deepcopy(profiles[bundle]);wrong['DeveloperCertificates']=[]
            guard('wrong certificate '+bundle,lambda:profile_call(bundle,wrong),'certificate is not included')
        for bundle in mod.sign.IDS[:2]:
            missing=copy.deepcopy(profiles[bundle]);missing['Entitlements']['com.apple.security.application-groups']=[]
            guard('missing App Group '+bundle,lambda:profile_call(bundle,missing),'must authorize App Group')
        # Publisher validates all three receipt summaries and embedded signed
        # entitlements. Mock only CMS/certificate decoding, entitlement decoding
        # and final binary inspector; inspect_ipa, profile guards and receipts real.
        policy_ipa=temp/'policy-only.ipa';policy_receipt=temp/'policy-only.signing.json'
        folders={b:('Payload/Policy.app' if i==0 else 'Payload/Policy.app/PlugIns/'+str(i)+'.appex')
            for i,b in enumerate(mod.sign.IDS)}
        summaries=[]
        with zipfile.ZipFile(policy_ipa,'w') as archive:
            for bundle in mod.sign.IDS:
                folder=folders[bundle];prov=profiles[bundle]
                info={'CFBundleIdentifier':bundle,'CFBundleExecutable':bundle,'CFBundleShortVersionString':'1.0.0','CFBundleVersion':'42'}
                archive.writestr(folder+'/Info.plist',plistlib.dumps(info))
                archive.writestr(folder+'/embedded.mobileprovision',bundle.encode())
                archive.writestr(folder+'/'+bundle,bundle.encode())
                archive.writestr(folder+'/_CodeSignature/CodeResources',b'policy seal')
                summaries.append({'bundle_id':bundle,'executable':bundle,'version':'1.0.0','build':'42',
                    'profile_uuid':prov['UUID'],'profile_expires':prov['ExpirationDate'].isoformat()+'Z',
                    'provisioned_device_count':1,'all_devices':False,'app_groups':[mod.sign.GROUP]})
        report={'status':'signed-structurally-checked','sha256':mod.digest(policy_ipa),'zsign_revision':mod.sign.ZSIGN_REVISION,
            'apple_device_installation_verified':False,'signing_certificate_sha256':certsha,'bundles':summaries}
        policy_receipt.write_text(json.dumps(report))
        cert_dates=['notBefore='+(now-dt.timedelta(days=1)).strftime('%b %d %H:%M:%S %Y GMT'),
            'notAfter='+(now+dt.timedelta(days=30)).strftime('%b %d %H:%M:%S %Y GMT')]
        def decoded(command, message):
            if command[1]=='cms':return plistlib.dumps(profiles[Path(command[command.index('-in')+1]).read_bytes().decode()])
            if '-subject' in command:return b'subject=CN=Policy boundary only'
            if '-dates' in command:return ('\n'.join(cert_dates)+'\n').encode()
            raise AssertionError(command)
        def entitlements(binary):return profiles[binary.decode()]['Entitlements']
        from types import SimpleNamespace
        original_load=mod.load
        def mocked_signature_loader(name,path):
            return SimpleNamespace(verify_ipa=lambda *args: {'synthetic_policy_only':True}) if name=='linux_signature_integrity' else original_load(name,path)
        with patch.object(mod.sign,'run',side_effect=decoded),patch.object(mod.sign,'signed_entitlements',side_effect=entitlements),patch.object(mod.verify,'verify'),patch.object(mod,'load',side_effect=mocked_signature_loader):
            assert mod.validate(policy_ipa,policy_receipt,None)==('1.0.0','42')
            guard('unprovisioned device in every bundle',lambda:mod.validate(policy_ipa,policy_receipt,
                {'build':'42','version':'1.0.0','device_udid':'NOT-PROVISIONED'}),'not provisioned in every bundle')
            report['bundles']=summaries[:2];policy_receipt.write_text(json.dumps(report))
            guard('all three signing summaries mandatory',lambda:mod.validate(policy_ipa,policy_receipt,None),'summaries mismatch')
            report['bundles']=summaries;policy_receipt.write_text(json.dumps(report))
            with patch.object(mod.sign,'signed_entitlements',return_value={}):
                guard('embedded signed entitlement mismatch',lambda:mod.validate(policy_ipa,policy_receipt,None),'Signed entitlements differ')
            cert_dates[1]='notAfter='+(now-dt.timedelta(seconds=1)).strftime('%b %d %H:%M:%S %Y GMT')
            guard('expired signing certificate',lambda:mod.validate(policy_ipa,policy_receipt,None),'Certificate not currently valid')
        trace.append('PASS: synthetic profile/receipt unit guards cover all3, expiry, certificate, exact entitlement and device compatibility; cryptographic parser mocks are NOT signing evidence.')
        # Wrapper public help/invalid operation; never invoke a build or signer.
        for operation, expected in [('--help',0),('unknown-operation',2)]:
            result=subprocess.run(['bash',str(ROOT/'apple/scripts/release-ios-linux.sh'),operation],capture_output=True,text=True)
            assert result.returncode==expected
            trace.append('wrapper '+operation+' exit='+str(result.returncode))
        trace.append('PASS: refusals preserve every prior asset; policy mock staging preserves older history; no deployment performed.')
finally:
    (args.output_dir/'journeys.log').write_text('\n'.join(trace)+'\n')
print('\n'.join(trace))
