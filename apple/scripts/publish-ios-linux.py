#!/usr/bin/env python3
"""Stage a structurally checked Linux signed IPA locally. Never claim Apple trust.

Automatic deployment is intentionally disabled: Wrangler asset deployment replaces
its entire asset set; there is no verified remote complete-history reconciliation
in this tool. See apple/xtool/local-release.md for manual deployment prerequisites.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sign = load('linux_sign', HERE / 'sign-ios-linux.py')
verify = load('linux_verify', HERE / 'verify-ios-linux.py')
ota = load('ota_common', HERE / 'publish-mac-update.py')
require = sign.require


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def safe_path(path):
    """Reject symlink ancestors before resolving (including dangling links)."""
    lexical = path.expanduser()
    if not lexical.is_absolute():
        lexical = Path.cwd() / lexical
    require(not any(part.is_symlink() for part in (lexical, *lexical.parents)),
            'Symlinks are forbidden in release paths.')
    return Path(os.path.abspath(lexical))


def json_file(path):
    path = safe_path(path)
    require(path.is_file() and not path.is_symlink(), 'Receipt must be a regular non-symlink file.')
    value = json.loads(path.read_text())
    require(isinstance(value, dict), 'Receipt must be a JSON object.')
    return value


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z', value), 'Receipt needs an absolute UTC timestamp.')
    return dt.datetime.fromisoformat(value[:-1] + '+00:00')


def device_receipt(path, sha):
    value = json_file(path)
    require(value.get('status') == 'device-tested' and value.get('sha256') == sha,
            'Missing real-device confirmation or device receipt IPA hash mismatch.')
    now = dt.datetime.now(dt.timezone.utc)
    require(timestamp(value.get('tested_at')) <= now, 'Device observation is dated in the future.')
    for name in ('observer', 'device_udid', 'observations'):
        require(isinstance(value.get(name), str) and value[name].strip(), 'Device receipt needs ' + name + '.')
    require(not any(token in json.dumps(value).lower() for token in ('synthetic', 'mock', 'fixture')),
            'Synthetic/test observations are not publication authorization.')
    require(isinstance(value.get('checks'), dict), 'Device receipt checks must be an object.')
    for name in ('installation', 'app_launch', 'share_extension', 'widgets', 'app_groups', 'voice', 'app_intents'):
        require(value['checks'].get(name) is True, 'Real-device check unconfirmed: ' + name)
    return value


def validate(ipa, receipt, device):
    sha = digest(ipa)
    report = json_file(receipt)
    require(report.get('status') == 'signed-structurally-checked' and report.get('sha256') == sha,
            'Signing receipt missing, unsigned input, or IPA hash mismatch.')
    require(report.get('zsign_revision') == sign.ZSIGN_REVISION,
            'Signing receipt requires the pinned Linux zsign revision.')
    require(report.get('apple_device_installation_verified') is False,
            'Signing receipt must not misrepresent structural validation as Apple/device proof.')
    cert_sha = report.get('signing_certificate_sha256', '')
    require(isinstance(cert_sha, str) and re.fullmatch('[0-9a-f]{64}', cert_sha), 'Invalid signing certificate hash.')
    bundles = sign.inspect_ipa(ipa)
    infos = [bundles[b][1] for b in sign.IDS]
    version = str(infos[0].get('CFBundleShortVersionString', ''))
    build = str(infos[0].get('CFBundleVersion', ''))
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version), 'Invalid release version.')
    ota.build_number(build)
    require(all(str(i.get('CFBundleVersion')) == build and str(i.get('CFBundleShortVersionString')) == version for i in infos),
            'Bundle version/build mismatch.')
    require(not device or (str(device.get('build')) == build and device.get('version') == version),
            'Device receipt build/version mismatch.')
    summaries, profiles = [], []
    now = dt.datetime.now(dt.timezone.utc)
    with tempfile.TemporaryDirectory(prefix='linux-ota-check-') as work, zipfile.ZipFile(ipa) as archive:
        for bundle in sign.IDS:
            folder, info = bundles[bundle]
            path = Path(work) / 'profile.mobileprovision'
            path.write_bytes(archive.read(folder + '/embedded.mobileprovision'))
            content = sign.run(['openssl', 'cms', '-verify', '-inform', 'DER', '-in', str(path), '-noverify'],
                               'Embedded profile CMS integrity failed.')
            raw = plistlib.loads(content)
            certs = [c for c in raw.get('DeveloperCertificates', []) if hashlib.sha256(c).hexdigest() == cert_sha]
            require(len(certs) == 1, 'Profile certificate does not match signing receipt.')
            cert_path = Path(work) / 'cert.der'
            cert_path.write_bytes(certs[0])
            subject = sign.run(['openssl', 'x509', '-inform', 'DER', '-in', str(cert_path), '-noout', '-subject'],
                               'Invalid profile certificate.').decode().lower()
            require(not any(t in subject for t in ('synthetic', 'mock', 'fixture')), 'Synthetic certificate is not releasable.')
            dates = sign.run(['openssl', 'x509', '-inform', 'DER', '-in', str(cert_path), '-noout', '-dates'],
                             'Cannot read certificate dates.').decode().splitlines()
            require(len(dates) == 2 and {line.split('=', 1)[0] for line in dates} == {'notBefore', 'notAfter'}, 'Invalid certificate dates.')
            for line in dates:
                field, date = line.split('=', 1)
                date = dt.datetime.strptime(date, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=dt.timezone.utc)
                require(date <= now if field == 'notBefore' else date > now, 'Certificate not currently valid.')
            profile = sign.profile(path, bundle, certs[0], now)
            require(not device or profile.get('ProvisionsAllDevices') is True or device['device_udid'] in profile['ProvisionedDevices'],
                    'Tested device is not provisioned in every bundle.')
            actual = sign.signed_entitlements(archive.read(folder + '/' + info['CFBundleExecutable']))
            require(actual == profile['Entitlements'], 'Signed entitlements differ from embedded profile.')
            require(archive.read(folder + '/_CodeSignature/CodeResources'), 'Missing resource seal.')
            profiles.append(profile)
            summaries.append(dict(bundle_id=bundle, executable=info['CFBundleExecutable'],
                version=info.get('CFBundleShortVersionString'), build=info.get('CFBundleVersion'),
                profile_uuid=profile.get('UUID'), profile_expires=profile['ExpirationDate'].isoformat()+'Z',
                provisioned_device_count=len(profile.get('ProvisionedDevices', [])),
                all_devices=profile.get('ProvisionsAllDevices', False),
                app_groups=actual.get('com.apple.security.application-groups', [])))
    require(len({p['TeamIdentifier'][0] for p in profiles}) == 1, 'Profiles do not share one team.')
    device_sets = [set(p['ProvisionedDevices']) for p in profiles if not p.get('ProvisionsAllDevices')]
    require(not device_sets or bool(set.intersection(*device_sets)), 'Profiles have no common provisioned device.')
    require(report.get('bundles') == summaries, 'Signing receipt bundle/profile summaries mismatch.')
    verify.verify(ipa)  # arm64 executable code, extension entry/classes and WebRTC
    return version, build


def tree_hashes(assets):
    values = {}
    for path in assets.rglob('*'):
        require(not path.is_symlink(), 'Symlink in persistent OTA assets.')
        require(path.is_dir() or path.is_file(), 'Non-regular asset.')
        if path.is_file():
            values[path.relative_to(assets).as_posix()] = digest(path)
    return values


def baseline(assets, path):
    value = json_file(path)
    require(value.get('status') == 'complete-live-snapshot' and value.get('origin') == ota.ORIGIN,
            'A complete current live-site asset snapshot receipt is required; do not bootstrap over an existing site.')
    files = value.get('files')
    require(isinstance(files, dict) and files and 'latest.json' in files,
            'Empty/incomplete live baseline is unsupported for the existing OTA site.')
    require(files == tree_hashes(assets), 'Live baseline receipt does not hash-match every persistent asset.')
    require(timestamp(value.get('observed_at')) <= dt.datetime.now(dt.timezone.utc), 'Future baseline receipt.')
    require(value.get('observer'), 'Baseline requires an identified operator.')


def history(assets):
    """Check all immutable archived builds, not just the proposed destination."""
    previous = json_file(assets / 'latest.json')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', str(previous.get('version', ''))),
            'Invalid previous release version.')
    latest_build = str(previous.get('build', ''))
    ota.build_number(latest_build)
    require(previous.get('bundle_id') == ota.BUNDLE and previous.get('manifest_url') ==
            f'{ota.ORIGIN}/builds/{latest_build}/manifest.plist', 'Previous release target mismatch.')
    builds = assets / 'builds'
    require(builds.is_dir(), 'Missing immutable build history.')
    versions = {}
    for folder in builds.iterdir():
        require(folder.is_dir(), 'Unexpected non-directory in immutable history.')
        ota.build_number(folder.name)
        require(ota.build_number(folder.name) <= ota.build_number(latest_build),
                'Immutable history is newer than latest; reconcile the baseline first.')
        ipa = folder / 'Nanocodex.ipa'
        require(ipa.is_file(), 'Incomplete immutable history: missing archived IPA.')
        data = plistlib.loads((folder / 'manifest.plist').read_bytes())
        title = data['items'][0]['metadata']['title']
        require(isinstance(title, str) and re.fullmatch(r'Nanocodex [0-9]+\.[0-9]+\.[0-9]+', title),
                'Invalid immutable release version.')
        version = title[len('Nanocodex '):]
        require((folder / 'manifest.plist').read_bytes() == ota.manifest(version, folder.name)
                and (folder / 'index.html').read_text() == ota.page(version, folder.name)
                and (folder / 'sha256.txt').read_text() == digest(ipa) + '  Nanocodex.ipa\n',
                'Incomplete or inconsistent immutable history.')
        versions[folder.name] = version
    require(versions.get(latest_build) == previous['version'], 'Latest points to missing or inconsistent history.')
    return previous


def deploy_attestation(args, sha):
    """User observations are necessary, never inferred from a signing receipt."""
    require(args.device_test_receipt and args.user_tested_sha256,
            '--deploy requires a real user device-test receipt and --user-tested-sha256 attestation.')
    require(re.fullmatch('[0-9a-f]{64}', args.user_tested_sha256) and args.user_tested_sha256 == sha,
            'User on-device SHA256 attestation must match exactly this signed IPA.')
    return device_receipt(args.device_test_receipt, sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ipa', type=Path, required=True)
    parser.add_argument('--assets-dir', type=Path, required=True)
    parser.add_argument('--signing-receipt', type=Path, help='Defaults to IPA.signing.json')
    parser.add_argument('--device-test-receipt', type=Path, help='Private manual observations, hash-bound to exactly this signed IPA')
    parser.add_argument('--baseline-receipt', type=Path, required=True, help='Complete persistent live-asset inventory obtained independently by operator')
    parser.add_argument('--upload-dir', type=Path, help='Optional NEW external all-history upload tree; generated with chunk-ios-ota.py after archive preparation')
    parser.add_argument('--notes')
    parser.add_argument('--deploy', action='store_true', help='Reserved fail-closed publication request; never deploys until remote reconciliation is implemented')
    parser.add_argument('--user-tested-sha256', help='Exact signed SHA explicitly attested by the USER after on-device journeys; required for --deploy')
    args = parser.parse_args()
    require(sys.platform == 'linux' and not sys.flags.optimize, 'Linux with Python assertions enabled is required.')
    require(args.deploy or args.user_tested_sha256 is None, '--user-tested-sha256 is only valid with --deploy.')
    ipa = safe_path(args.ipa)
    require(args.ipa.is_file() and not args.ipa.is_symlink(), 'IPA must be an existing regular non-symlink file.')
    assets = safe_path(args.assets_dir)
    require(not assets.is_relative_to(REPO) and not REPO.is_relative_to(assets), 'Assets must be a dedicated persistent directory outside repo.')
    require(assets.is_dir() and not args.assets_dir.is_symlink(), 'Existing complete persistent asset directory is required.')
    upload = safe_path(args.upload_dir) if args.upload_dir else None
    helper = HERE / 'chunk-ios-ota.py'
    if upload:
        require(not args.upload_dir.is_symlink() and not upload.exists(), 'Upload directory must be a new non-symlink path.')
        require(not upload.is_relative_to(REPO) and not REPO.is_relative_to(upload)
                and not upload.is_relative_to(assets) and not assets.is_relative_to(upload),
                'Upload directory must be outside repo and separate from archival assets.')
        require(helper.is_file(), 'The chunk-ios-ota.py helper is required for upload generation.')
    receipt = args.signing_receipt or Path(str(ipa)+'.signing.json')
    # Snapshot the input to avoid hashing and validating different IPA bytes.
    lock_path = safe_path(assets.parent / ('.'+assets.name+'.ota.lock'))
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        baseline(assets, args.baseline_receipt)
        with tempfile.TemporaryDirectory(prefix='linux-release-') as work:
            frozen = Path(work)/'signed.ipa'
            with ipa.open('rb') as source, frozen.open('wb') as destination_file:
                __import__('shutil').copyfileobj(source, destination_file, 1024 * 1024)
            if args.deploy:
                deploy_attestation(args, digest(frozen))
                require(False, 'Automatic deployment disabled: complete live-history reconciliation remains unverified; no staging or network write performed; see apple/xtool/local-release.md.')
            device = device_receipt(args.device_test_receipt, digest(frozen)) if args.device_test_receipt else None
            version, build = validate(frozen, receipt, device)
            previous = history(assets)
            require(tuple(map(int, version.split('.'))) >= tuple(map(int, previous['version'].split('.'))), 'Refusing version downgrade.')
            destination = assets / 'builds' / build
            if destination.exists():
                require((destination/'index.html').read_text() == ota.page(version, build), 'Existing immutable index metadata differs.')
                require((destination/'sha256.txt').read_text() == digest(frozen)+'  Nanocodex.ipa\n', 'Existing immutable checksum differs.')
            ota.prepare(frozen, assets, version, build, args.notes)
        if upload:
            # Portable prepare retains full archived IPAs for immutable reuse;
            # only the helper's separate filtered tree is suitable for uploads.
            subprocess.run([sys.executable, str(helper), '--source', str(assets), '--destination', str(upload)], check=True)
        print('Offline staging only. No deployment or Apple trust verification performed.')
        print('Archival feed contains full IPAs; NEVER deploy it directly (Static Assets file limit).')
        if upload:
            print('Separate all-history chunked upload tree prepared: ' + str(upload))
        else:
            print('Generate a separate all-history chunked upload tree:')
            import shlex
            print('python3 apple/scripts/chunk-ios-ota.py --source ' + shlex.quote(str(assets)) + ' --destination NEW_EXTERNAL_UPLOAD_TREE')
        print('Manual deployment requires complete live-history reconciliation and actual user-tested signed SHA; see apple/xtool/local-release.md.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, IndexError, TypeError, AssertionError, EOFError, __import__('struct').error, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        # Avoid echoing provisioning/CMS diagnostics or private device identifiers.
        raise SystemExit('Linux OTA staging refused: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__))
