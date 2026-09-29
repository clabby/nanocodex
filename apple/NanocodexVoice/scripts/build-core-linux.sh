#!/usr/bin/env bash
# Build only the physical iPhone slice. Supply a legally obtained iPhoneOS SDK.
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: SDKROOT=/path/to/iPhoneOS.sdk ./apple/NanocodexVoice/scripts/build-core-linux.sh

Requires Linux, Cargo/Rust with the aarch64-apple-ios target installed, clang,
llvm-ar, Python 3, and an installed iPhoneOS SDK (not an iPhoneSimulator SDK).
Install the Rust target with: rustup target add aarch64-apple-ios

Options are environment variables:
  SDKROOT                       Required path to the installed iPhoneOS SDK
  IPHONEOS_DEPLOYMENT_TARGET     Minimum iOS version (default: 17.0)
  VOICE_CORE_CLANG               Clang executable (default: clang)
  VOICE_CORE_AR                  LLVM archiver executable (default: llvm-ar)
  CARGO_TARGET_DIR               Cargo build directory (default: target)
  VOICE_CORE_ARTIFACT_DIR        Output XCFramework path (default: package Artifacts)

The output replaces NanocodexVoiceCore.xcframework with one ios-arm64 slice.
It does not contain macOS or simulator slices. Use build-core.sh for those.
HELP
}
fail() { printf 'build-core-linux: %s\n' "$*" >&2; exit 1; }
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then usage; exit 0; fi
[[ $# == 0 ]] || fail 'Unexpected arguments; run with --help for usage.'
[[ "$(uname -s)" == Linux ]] || fail 'This script requires Linux.'
[[ -n "${SDKROOT:-}" ]] || fail 'SDKROOT is required; point it at an installed iPhoneOS SDK.'
[[ -d "$SDKROOT" ]] || fail "SDKROOT does not exist: $SDKROOT"
export SDKROOT="$(cd "$SDKROOT" && pwd -P)"
[[ -f "$SDKROOT/usr/lib/libSystem.tbd" && -d "$SDKROOT/System/Library/Frameworks" ]] ||
  fail 'SDKROOT must contain a complete iPhoneOS SDK (usr/lib/libSystem.tbd and System/Library/Frameworks).'
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repository_root"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-17.0}"
[[ "$IPHONEOS_DEPLOYMENT_TARGET" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail 'Invalid IPHONEOS_DEPLOYMENT_TARGET; use a version such as 17.0.'
for tool in cargo rustc python3 realpath; do command -v "$tool" >/dev/null || fail "Required tool is missing: $tool"; done
VOICE_CORE_CLANG="$(command -v "${VOICE_CORE_CLANG:-clang}")" || fail 'Clang is missing; set VOICE_CORE_CLANG.'
VOICE_CORE_AR="$(command -v "${VOICE_CORE_AR:-llvm-ar}")" || fail 'LLVM archiver is missing; set VOICE_CORE_AR.'
# Confirm the SDK identity independently of compiler target macros.
python3 - "$SDKROOT" <<'SDK'
import json
import pathlib
import plistlib
import sys
root = pathlib.Path(sys.argv[1])
if (root / "SDKSettings.plist").is_file():
    with (root / "SDKSettings.plist").open("rb") as stream:
        settings = plistlib.load(stream)
elif (root / "SDKSettings.json").is_file():
    settings = json.loads((root / "SDKSettings.json").read_text())
else:
    sys.exit("build-core-linux: SDKROOT has no SDKSettings.plist or SDKSettings.json")
canonical_name = settings.get("CanonicalName", "").lower()
if not canonical_name.startswith("iphoneos"):
    sys.exit(f"build-core-linux: expected an iPhoneOS SDK, got {canonical_name!r}")
SDK
# Make executable paths independent of Cargo build-script directories.
export VOICE_CORE_CLANG="$(realpath "$VOICE_CORE_CLANG")"
export VOICE_CORE_AR="$(realpath "$VOICE_CORE_AR")"
target=aarch64-apple-ios
rust_target_libdir="$(rustc --print target-libdir --target "$target")"
compgen -G "$rust_target_libdir/libstd-*.rlib" >/dev/null ||
  fail 'Rust iOS standard library is missing; run: rustup target add aarch64-apple-ios'
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repository_root/target}"
if [[ "$CARGO_TARGET_DIR" != /* ]]; then export CARGO_TARGET_DIR="$repository_root/$CARGO_TARGET_DIR"; fi
artifact="${VOICE_CORE_ARTIFACT_DIR:-$repository_root/apple/NanocodexVoice/Artifacts/NanocodexVoiceCore.xcframework}"
if [[ "$artifact" != /* ]]; then artifact="$repository_root/$artifact"; fi
[[ "$artifact" == *.xcframework ]] || fail 'VOICE_CORE_ARTIFACT_DIR must end in .xcframework.'
mkdir -p "$CARGO_TARGET_DIR/voice-core" "$(dirname "$artifact")"
build_tools="$(mktemp -d "$CARGO_TARGET_DIR/voice-core/linux-tools.XXXXXX")"
staging="$(mktemp -d "$(dirname "$artifact")/.voice-core.XXXXXX")"
trap 'rm -rf "$build_tools" "$staging"' EXIT
# Keep the SDK path as one argument, including when it contains spaces.
# Target-scoped variables leave host proc macros and build scripts on Linux.
cat > "$build_tools/clang-ios" <<'CLANG'
#!/usr/bin/env bash
set -euo pipefail
exec "$VOICE_CORE_CLANG" --target="arm64-apple-ios${IPHONEOS_DEPLOYMENT_TARGET}" -isysroot "$SDKROOT" "$@"
CLANG
chmod +x "$build_tools/clang-ios"
export CC_aarch64_apple_ios="$build_tools/clang-ios"
export AR_aarch64_apple_ios="$VOICE_CORE_AR"
export CARGO_TARGET_AARCH64_APPLE_IOS_LINKER="$build_tools/clang-ios"
export CARGO_TARGET_AARCH64_APPLE_IOS_AR="$VOICE_CORE_AR"
# Compile against the actual SDK before replacing an existing artifact.
printf '#include <TargetConditionals.h>\n#if !TARGET_OS_IOS || TARGET_OS_SIMULATOR\n#error Expected an iPhoneOS device SDK\n#endif\n#include <stdint.h>\nint voice_core_sdk_probe(void) { return sizeof(uintptr_t); }\n' |
  "$CC_aarch64_apple_ios" -x c -c -o "$build_tools/sdk-probe.o" -
"$VOICE_CORE_AR" rcs "$build_tools/sdk-probe.a" "$build_tools/sdk-probe.o"
cargo build --locked -p nanocodex-voice-ffi --release --target "$target"
archive="$CARGO_TARGET_DIR/$target/release/libnanocodex_voice_ffi.a"
[[ -s "$archive" ]] || fail "Cargo did not produce $archive"
# One device architecture needs neither lipo nor xcodebuild.
python3 - "$archive" "$repository_root/crates/nanocodex-voice-ffi/include" "$staging" <<'PY'
import pathlib
import plistlib
import shutil
import sys
archive, headers, output = map(pathlib.Path, sys.argv[1:])
slice_path = output / "ios-arm64"
slice_path.mkdir()
shutil.copy2(archive, slice_path / archive.name)
shutil.copytree(headers, slice_path / "Headers")
with (output / "Info.plist").open("wb") as stream:
    plistlib.dump({
        "AvailableLibraries": [{
            "LibraryIdentifier": "ios-arm64",
            "LibraryPath": archive.name,
            "HeadersPath": "Headers",
            "SupportedArchitectures": ["arm64"],
            "SupportedPlatform": "ios",
        }],
        "CFBundlePackageType": "XFWK",
        "XCFrameworkFormatVersion": "1.0",
    }, stream)
PY
rm -rf "$artifact"
mv "$staging" "$artifact"
printf 'Built iPhone device XCFramework: %s\n' "$artifact"
