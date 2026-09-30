#!/usr/bin/env python3
"""Sign a three-bundle device IPA with per-bundle provisioning profiles.

Reviewed zsign source: zhlynn/zsign@614caa8d1ca949e260e5746144aa52d27a4b08d6:
src/zsign.cpp (multiple -m), src/openssl.cpp (profile entitlements), and
src/bundle.cpp (match profile before sealing). Never pass -e: that overrides
ALL profiles with one entitlement set. No Apple account/network login occurs.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

IDS = ("xyz.paradigm.centaur", "xyz.paradigm.centaur.share", "xyz.paradigm.centaur.widgets")
GROUP = "group.xyz.paradigm.centaur"
ZSIGN_REVISION = "614caa8d1ca949e260e5746144aa52d27a4b08d6"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(args, message, data=None):
    # Do not forward tool diagnostics: provisioning files contain device IDs.
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL if data is None else None)
    require(result.returncode == 0, message)
    return result.stdout


def local_file(name, private=False, executable=False):
    value = os.environ.get(name)
    require(value, f"Set {name} to a local file path; see --help.")
    path = Path(value).expanduser().resolve()
    require(path.is_file(), f"{name} must name an existing regular file.")
    if private:
        info = path.stat()
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077,
                f"{name} must be owned by this user and have mode 0600 or 0400.")
    if executable:
        require(os.access(path, os.X_OK), f"{name} is not executable.")
    return path


def profile(path, bundle, cert_der, now):
    content = run(["openssl", "cms", "-verify", "-inform", "DER", "-in", str(path),
                   "-noverify"], f"Invalid CMS signature or unreadable profile for {bundle}.")
    # -noverify checks CMS integrity, NOT whether the issuer is trusted by Apple.
    value = plistlib.loads(content)
    ent = value.get("Entitlements", {})
    prefixes = value.get("ApplicationIdentifierPrefix", [])
    require(ent.get("application-identifier") in [f"{p}.{bundle}" for p in prefixes]
            and "*" not in ent["application-identifier"],
            f"Profile for {bundle} needs its exact application-identifier (no wildcard).")
    teams = value.get("TeamIdentifier", [])
    require(len(teams) == 1 and ent.get("com.apple.developer.team-identifier") == teams[0],
            f"Profile team entitlement mismatch for {bundle}.")
    expires = value.get("ExpirationDate")
    require(isinstance(expires, dt.datetime) and expires.replace(tzinfo=dt.timezone.utc) > now,
            f"Expired or undated profile for {bundle}.")
    created = value.get("CreationDate")
    require(isinstance(created, dt.datetime) and created.replace(tzinfo=dt.timezone.utc) <= now,
            f"Profile for {bundle} is not yet valid or has no creation date.")
    require(cert_der in value.get("DeveloperCertificates", []),
            f"Signing certificate is not included in the profile for {bundle}.")
    devices = value.get("ProvisionedDevices", [])
    require((isinstance(devices, list) and devices and all(isinstance(d, str) and d for d in devices))
            or value.get("ProvisionsAllDevices") is True,
            f"Profile for {bundle} is not a device development/ad-hoc/enterprise profile.")
    if bundle in IDS[:2]:
        require(GROUP in ent.get("com.apple.security.application-groups", []),
                f"Profile for {bundle} must authorize App Group {GROUP}.")
    return value


def inspect_ipa(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "IPA contains duplicate paths.")
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            require(not name.is_absolute() and ".." not in name.parts and "\\" not in entry.filename,
                    "IPA contains an unsafe archive path.")
            require(not stat.S_ISLNK(entry.external_attr >> 16), "Symlinks in IPA are unsupported.")
        bundles = {}
        for name in names:
            parts = PurePosixPath(name).parts
            if len(parts) < 3 or parts[-1] != "Info.plist" or not parts[-2].endswith((".app", ".appex")):
                continue
            require((len(parts) == 3 and parts[0] == "Payload" and parts[1].endswith(".app")) or
                    (len(parts) == 5 and parts[0] == "Payload" and parts[1].endswith(".app") and
                     parts[2] == "PlugIns" and parts[3].endswith(".appex")),
                    "Expected one Payload app with exactly two direct PlugIns extensions.")
            info = plistlib.loads(archive.read(name))
            bundle = info.get("CFBundleIdentifier")
            require(bundle in IDS and bundle not in bundles, "IPA contains an unexpected or duplicate bundle ID.")
            require((bundle == IDS[0]) == (len(parts) == 3), "Main app/extension layout mismatch.")
            executable = info.get("CFBundleExecutable", "")
            require(executable and "/" not in executable and "\\" not in executable and executable not in (".", ".."),
                    f"Invalid CFBundleExecutable for {bundle}.")
            folder = str(PurePosixPath(name).parent)
            require(f"{folder}/{executable}" in names, f"Missing executable for {bundle}.")
            bundles[bundle] = (folder, info)
        require(set(bundles) == set(IDS), "IPA must contain main, share, and widgets bundles.")
        root = bundles[IDS[0]][0]
        require(all(folder.startswith(root + "/PlugIns/") for bundle, (folder, _) in bundles.items()
                    if bundle != IDS[0]), "Extensions must belong to the main app.")
        return bundles


def signed_entitlements(binary):
    # Linux build produces thin arm64. Reject unexpected formats instead of
    # silently checking only one architecture of a universal executable.
    require(binary[:4] == b"\xcf\xfa\xed\xfe" and len(binary) >= 32,
            "Expected a thin little-endian 64-bit Mach-O executable.")
    require(struct.unpack_from("<I", binary, 4)[0] == 0x100000c, "Expected an arm64 executable.")
    count = struct.unpack_from("<I", binary, 16)[0]
    offset = 32
    signature = None
    for _ in range(count):
        command, size = struct.unpack_from("<II", binary, offset)
        require(size >= 8 and offset + size <= len(binary), "Malformed Mach-O load command.")
        if command == 0x1d:  # LC_CODE_SIGNATURE
            start, length = struct.unpack_from("<II", binary, offset + 8)
            require(start + length <= len(binary), "Truncated code signature.")
            signature = binary[start:start + length]
        offset += size
    require(signature is not None and len(signature) >= 12, "Executable has no code signature.")
    magic, size, count = struct.unpack_from(">III", signature)
    require(magic == 0xfade0cc0 and size <= len(signature), "Invalid signature superblob.")
    entitlements = None
    cms = False
    for i in range(count):
        slot, offset = struct.unpack_from(">II", signature, 12 + 8 * i)
        magic, size = struct.unpack_from(">II", signature, offset)
        require(size >= 8 and offset + size <= len(signature), "Truncated signature slot.")
        if slot == 5 and magic == 0xfade7171:
            entitlements = plistlib.loads(signature[offset + 8:offset + size].rstrip(b"\0"))
        if slot == 0x10000 and magic == 0xfade0b01 and size > 8:
            cms = True
    require(cms and entitlements is not None, "Executable lacks CMS signature or XML entitlements.")
    return entitlements


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Required environment (all local files):
  ZSIGN_PATH          pinned zsign built by install-zsign-linux.sh
  IOS_SIGNING_KEY     unencrypted PEM private key, owned by you, mode 0600/0400
  IOS_SIGNING_CERT    corresponding PEM or DER Apple signing certificate
  IOS_PROFILE_MAIN   profile for xyz.paradigm.centaur
  IOS_PROFILE_SHARE  profile for xyz.paradigm.centaur.share
  IOS_PROFILE_WIDGETS profile for xyz.paradigm.centaur.widgets
Optional IOS_DEVICE_UDID checks that exact device in all three profiles.
Without it, device profiles must share at least one provisioned device.
Main and share profiles must authorize group.xyz.paradigm.centaur.
Passwords/P12 inputs are unsupported: provision an unencrypted PEM key through
private local storage. This script never prompts for, downloads, or logs secrets.
Output is mode 0600 and includes embedded profiles (and their device identifiers).
A .signing.json report records structural checks, not Apple trust, revocation,
full resource/code-hash validation, or successful installation on an Apple device.
""")
    parser.add_argument("input", type=Path, help="unsigned three-bundle arm64 IPA")
    parser.add_argument("output", type=Path, help="new signed IPA (must not already exist)")
    args = parser.parse_args()
    require(sys.platform == "linux", "This signing path requires Linux.")
    require(shutil.which("openssl"), "OpenSSL is required.")
    require(args.input.is_file(), "Input IPA does not exist.")
    require(not args.output.exists() and not args.output.is_symlink(), "Output already exists; choose a new path.")
    report_path = Path(str(args.output) + ".signing.json")
    require(not report_path.exists() and not report_path.is_symlink(), "Signing report already exists.")
    zsign = local_file("ZSIGN_PATH", executable=True)
    key = local_file("IOS_SIGNING_KEY", private=True)
    cert = local_file("IOS_SIGNING_CERT")
    paths = [local_file("IOS_PROFILE_" + role) for role in ("MAIN", "SHARE", "WIDGETS")]
    key_data = key.read_bytes()
    require(b"PRIVATE KEY-----" in key_data and b"ENCRYPTED" not in key_data,
            "IOS_SIGNING_KEY must be an unencrypted PEM private key; P12/password inputs are unsupported.")
    del key_data
    version = run([str(zsign), "--version"], "Cannot run local zsign.").decode().strip()
    require(version == f"version: nanocodex-{ZSIGN_REVISION}",
            "Use the reviewed zsign build from apple/scripts/install-zsign-linux.sh.")
    now = dt.datetime.now(dt.timezone.utc)
    cert_format = "PEM" if b"-----BEGIN CERTIFICATE-----" in cert.read_bytes() else "DER"
    cert_args = ["openssl", "x509", "-inform", cert_format, "-in", str(cert)]
    cert_der = run(cert_args + ["-outform", "DER"], "Invalid signing certificate.")
    dates = run(cert_args + ["-noout", "-dates"], "Cannot read certificate validity.").decode().splitlines()
    for line in dates:
        field, value = line.split("=", 1)
        date = dt.datetime.strptime(value, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=dt.timezone.utc)
        require(date <= now if field == "notBefore" else date > now, "Signing certificate is expired or not yet valid.")
    cert_pub = run(cert_args + ["-pubkey", "-noout"], "Cannot read certificate public key.")
    key_pub = run(["openssl", "pkey", "-in", str(key), "-passin", "pass:", "-pubout"],
                  "Cannot read unencrypted PEM signing key.")
    require(cert_pub == key_pub, "Signing key does not match signing certificate.")
    profiles = [profile(p, bundle, cert_der, now) for p, bundle in zip(paths, IDS)]
    require(len({p["TeamIdentifier"][0] for p in profiles}) == 1, "All profiles must belong to the same team.")
    device_sets = [set(p["ProvisionedDevices"]) for p in profiles if not p.get("ProvisionsAllDevices")]
    common = set.intersection(*device_sets) if device_sets else None
    require(common is None or bool(common), "Profiles have no common provisioned device.")
    udid = os.environ.get("IOS_DEVICE_UDID")
    require(not udid or common is None or udid in common, "IOS_DEVICE_UDID is not provisioned in all three profiles.")
    before = inspect_ipa(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix=".ios-sign-", dir=args.output.parent) as temporary:
        temp = Path(temporary)
        signed = temp / "signed.ipa"
        command = [str(zsign), "-q", "-f", "-z", "9", "-k", str(key), "-c", str(cert)]
        for path in paths:
            command += ["-m", str(path)]
        command += ["-t", str(temp), "-o", str(signed), str(args.input.resolve())]
        run(command, "zsign failed; no signed output published. Check key/profile compatibility and local zsign installation.")
        require(signed.is_file(), "zsign returned without producing an IPA.")
        after = inspect_ipa(signed)
        require(before == after, "zsign changed bundle layout or Info.plist metadata.")
        summaries = []
        with zipfile.ZipFile(signed) as archive:
            for bundle, path, prov in zip(IDS, paths, profiles):
                folder, info = after[bundle]
                require(archive.read(folder + "/embedded.mobileprovision") == path.read_bytes(),
                        f"Wrong embedded profile for {bundle}.")
                actual = signed_entitlements(archive.read(folder + "/" + info["CFBundleExecutable"]))
                require(actual == prov["Entitlements"], f"Signed entitlements differ from profile for {bundle}.")
                require(archive.read(folder + "/_CodeSignature/CodeResources"), f"Missing resource seal for {bundle}.")
                summaries.append({"bundle_id": bundle, "executable": info["CFBundleExecutable"],
                    "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
                    "profile_uuid": prov.get("UUID"), "profile_expires": prov["ExpirationDate"].isoformat() + "Z",
                    "provisioned_device_count": len(prov.get("ProvisionedDevices", [])),
                    "all_devices": prov.get("ProvisionsAllDevices", False),
                    "app_groups": actual.get("com.apple.security.application-groups", [])})
        verifier_path = Path(__file__).with_name('verify-ios-signatures-linux.py')
        spec = importlib.util.spec_from_file_location('linux_signature_integrity', verifier_path)
        integrity = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(integrity)
        cryptographic = integrity.verify_ipa(signed, cert)
        report = {"status": "signed-structurally-checked", "zsign_revision": ZSIGN_REVISION, "apple_device_installation_verified": False,
                  "verification_limits": "CMS, code pages and supported resource seals verified; no Apple platform policy, revocation, trusted timestamp or device installation proof.",
                  "cms_and_code_resource_integrity_verified": True, "code_objects_verified": len(cryptographic["code_objects"]), "ipa_compression_level": 9,
                  "sha256": hashlib.sha256(signed.read_bytes()).hexdigest(),
                  "signing_certificate_sha256": hashlib.sha256(cert_der).hexdigest(),
                  "target_device_checked": bool(udid), "bundles": summaries}
        # Exclusive creation prevents overwriting another invocation's output.
        with args.output.open("xb") as target:
            target.write(signed.read_bytes())
        with report_path.open("x") as target:
            json.dump(report, target, indent=2)
            target.write("\n")
    print(f"Signed IPA: {args.output}\nStructural verification report: {report_path}")
    print("Apple device installation has not been verified.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, struct.error, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        print(f"sign-ios-linux: {error}", file=sys.stderr)
        sys.exit(1)
