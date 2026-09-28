#!/usr/bin/env python3
"""Materialize the patched webrtc-sys crate for the codex-voice workspace.

The pristine crates.io archive is taken from Cargo's download cache (or fetched
from static.crates.io when online), verified against the pinned SHA-256, and
extracted into the gitignored `vendor/webrtc-sys`, which `[patch.crates-io]`
points at. The overlay files are added and `webrtc-sys.patch` must apply
exactly; any mismatch aborts without touching an existing prepared tree.
Run this before any cargo command on third_party/codex-voice.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

CRATE, VERSION = "webrtc-sys", "0.3.45"
# crates.io index `cksum` for webrtc-sys 0.3.45.
SHA256 = "5a0908bea8bc16a098fc853983507f6d1588dd0b94492153c5edca551712a3cf"
URL = f"https://static.crates.io/crates/{CRATE}/{CRATE}-{VERSION}.crate"

HERE = Path(__file__).resolve().parent
PATCH = HERE / "webrtc-sys.patch"
OVERLAY = HERE / "overlay"
DEST = HERE.parents[1] / "vendor" / CRATE
STAMP = ".nanocodex-prepared"


def fail(message):
    sys.exit(f"prepare webrtc-sys: {message}")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def overlay_files():
    return sorted(p.relative_to(OVERLAY) for p in OVERLAY.rglob("*") if p.is_file())


def fingerprint():
    digest = hashlib.sha256(SHA256.encode())
    for path in [Path(__file__).resolve(), PATCH] + [OVERLAY / p for p in overlay_files()]:
        digest.update(path.relative_to(HERE).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def cached_crate():
    home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    for candidate in sorted((home / "registry" / "cache").glob(f"*/{CRATE}-{VERSION}.crate")):
        actual = sha256(candidate)
        if actual != SHA256:
            fail(f"checksum mismatch for {candidate}: expected {SHA256}, got {actual}; "
                 "delete the corrupt cache entry and retry")
        return candidate
    return None


def download(directory, offline):
    if offline:
        fail(f"{CRATE} {VERSION} is not in Cargo's download cache and the build is offline; "
             "run once online (or `cargo fetch` a project using it) first")
    target = Path(directory) / f"{CRATE}-{VERSION}.crate"
    subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", str(target), URL], check=True)
    actual = sha256(target)
    if actual != SHA256:
        fail(f"checksum mismatch for {URL}: expected {SHA256}, got {actual}")
    return target


def extract(archive, stage):
    prefix = f"{CRATE}-{VERSION}/"
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        for member in members:
            if not (member.name + "/").startswith(prefix) or ".." in Path(member.name).parts \
                    or not (member.isfile() or member.isdir()):
                fail(f"unexpected archive member {member.name!r}")
        if hasattr(tarfile, "data_filter"):
            tar.extractall(stage, members=members, filter="data")
        else:
            tar.extractall(stage, members=members)
    return Path(stage) / prefix


def apply(root):
    for relative in overlay_files():
        destination = root / relative
        if destination.exists():
            fail(f"overlay file {relative} already exists upstream; rebase the patch")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OVERLAY / relative, destination)
    # Outside any repository `git apply` behaves like a strict, atomic patch(1):
    # no fuzz, no partial application, identical on every platform.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CEILING_DIRECTORIES"] = str(root.parent)
    for check in (["--check"], []):
        result = subprocess.run(["git", "apply", "--whitespace=nowarn", *check, str(PATCH)],
                                cwd=root, env=env, text=True, capture_output=True)
        if result.returncode:
            fail(f"{PATCH.name} does not apply to {CRATE} {VERSION}:\n{result.stderr}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true",
                        help="never download (implied by CARGO_NET_OFFLINE=true)")
    parser.add_argument("--force", action="store_true", help="rebuild even when up to date")
    args = parser.parse_args()
    offline = args.offline or os.environ.get("CARGO_NET_OFFLINE", "").lower() in ("1", "true")
    expected = fingerprint()
    stamp = DEST / STAMP
    if not args.force and stamp.is_file() and stamp.read_text().strip() == expected:
        return
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{CRATE}-", dir=DEST.parent) as temporary:
        archive = cached_crate() or download(temporary, offline)
        root = extract(archive, Path(temporary) / "stage")
        apply(root)
        (root / STAMP).write_text(expected + "\n")
        if DEST.exists():
            DEST.rename(Path(temporary) / "previous")
        root.rename(DEST)
    print(f"prepared {DEST.relative_to(HERE.parents[3])} from {archive.name} (sha256 {SHA256[:12]})",
          file=sys.stderr)


if __name__ == "__main__":
    main()
