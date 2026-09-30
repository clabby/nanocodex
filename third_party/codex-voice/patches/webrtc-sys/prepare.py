#!/usr/bin/env python3
"""Materialize the patched webrtc-sys crate into the gitignored vendor/webrtc-sys.

See NANOCODEX.md. Run before any cargo command on third_party/codex-voice.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

CRATE, VERSION = "webrtc-sys", "0.3.45"
SHA256 = "5a0908bea8bc16a098fc853983507f6d1588dd0b94492153c5edca551712a3cf"  # crates.io index cksum
URL = f"https://static.crates.io/crates/{CRATE}/{CRATE}-{VERSION}.crate"
HERE = Path(__file__).resolve().parent
PATCH, OVERLAY = HERE / "webrtc-sys.patch", HERE / "overlay"
DEST = HERE.parents[1] / "vendor" / CRATE
STAMP = DEST / ".nanocodex-prepared"


def fail(message):
    sys.exit(f"prepare webrtc-sys: {message}")


def verified(path, source):
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != SHA256:
        fail(f"checksum mismatch for {source}: expected {SHA256}, got {actual}")
    return path


def fetch(directory):
    home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    for cached in sorted(home.glob(f"registry/cache/*/{CRATE}-{VERSION}.crate")):
        return verified(cached, f"{cached} (delete it and retry)")
    if os.environ.get("CARGO_NET_OFFLINE", "").lower() in ("1", "true"):
        fail(f"{CRATE} {VERSION} is not in Cargo's download cache and CARGO_NET_OFFLINE is set")
    target = Path(directory) / f"{CRATE}-{VERSION}.crate"
    subprocess.run(["curl", "-fsSL", "--retry", "3", "-o", target, URL], check=True)
    return verified(target, URL)


def main():
    overlay = sorted(p.relative_to(OVERLAY) for p in OVERLAY.rglob("*") if p.is_file())
    digest = hashlib.sha256(SHA256.encode())
    for path in [Path(__file__).resolve(), PATCH, *(OVERLAY / p for p in overlay)]:
        digest.update(path.relative_to(HERE).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    if STAMP.is_file() and STAMP.read_text().strip() == digest.hexdigest():
        return
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{CRATE}-", dir=DEST.parent) as temporary:
        archive = fetch(temporary)
        prefix = f"{CRATE}-{VERSION}/"
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar.getmembers():
                if not (member.name + "/").startswith(prefix) or ".." in Path(member.name).parts \
                        or not (member.isfile() or member.isdir()):
                    fail(f"unexpected archive member {member.name!r}")
            tar.extractall(temporary)
        root = Path(temporary) / prefix
        for relative in overlay:
            if (root / relative).exists():
                fail(f"overlay file {relative} already exists upstream; rebase the patch")
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(OVERLAY / relative, root / relative)
        # Outside a repository, `git apply` is a strict, atomic patch: no fuzz, all or nothing.
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env["GIT_CEILING_DIRECTORIES"] = temporary
        result = subprocess.run(["git", "apply", "--whitespace=nowarn", PATCH], cwd=root, env=env,
                                text=True, capture_output=True)
        if result.returncode:
            fail(f"{PATCH.name} does not apply to {CRATE} {VERSION}:\n{result.stderr}")
        (root / STAMP.name).write_text(digest.hexdigest() + "\n")
        if DEST.exists():
            DEST.rename(Path(temporary) / "previous")
        root.rename(DEST)
    print(f"prepared {DEST} from {archive.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
