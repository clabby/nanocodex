#!/usr/bin/env bash
# Compile Nanocodex and both extensions on Linux using xtool.
set -euo pipefail
fail() { printf 'build-ios-linux: %s\n' "$*" >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
[[ $(uname -s) == Linux ]] || fail 'This build requires Linux.'
sign=false
case ${1:-} in
  --sign) sign=true; shift;;
  --help|-h)
    echo 'Usage: build-ios-linux.sh [--sign]'
    echo 'Requires Swift 6.4, xtool 1.20.1, Rust iOS target, and an installed Apple SDK.'
    echo 'Set NANOCODEX_XTOOL to the xtool executable; SDKROOT optionally selects the iPhoneOS SDK.'
    echo 'Default output is unsigned. --sign requires a local zsign key, certificate and three device profiles.'
    exit 0;;
esac
[[ $# == 0 ]] || fail 'Unexpected arguments; use --help.'
xtool=${NANOCODEX_XTOOL:-xtool}
command -v "$xtool" >/dev/null || fail 'xtool is missing; run apple/scripts/install-xtool-linux.sh and set NANOCODEX_XTOOL.'
command -v python3 >/dev/null || fail 'Python 3 is required.'
xtool=$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$(command -v "$xtool")")
[[ $("$xtool" --version) == 'xtool 1.20.1' ]] || fail 'Expected xtool 1.20.1.'
sdk_status=$("$xtool" sdk status)
[[ $sdk_status != 'Not installed' ]] || fail 'Apple SDK is missing. Run xtool sdk install /path/to/Xcode.xip --slim on Linux.'
# The Rust build needs an SDK path; SwiftPM/xtool select their own installed SDK.
# Explicit SDKROOT is useful for non-default XDG configurations.
sdk=${SDKROOT:-}
if [[ -z $sdk ]]; then
  sdk=$(python3 - <<'PY'
import os, pathlib, sys
roots = [pathlib.Path.home()/'.swiftpm/swift-sdks']
if os.environ.get('XDG_CONFIG_HOME'):
    roots.insert(0, pathlib.Path(os.environ['XDG_CONFIG_HOME'])/'swiftpm/swift-sdks')
paths = {str(p.resolve()) for root in roots if root.exists() for p in root.rglob('iPhoneOS.sdk') if p.is_dir()}
if len(paths) == 1:
    print(paths.pop())
elif len(paths) > 1:
    sys.exit('Multiple iPhoneOS SDKs found; select one with SDKROOT.')
PY
  )
fi
[[ -n $sdk && -d $sdk ]] || fail 'Apple SDK is missing. Run xtool sdk install /path/to/Xcode.xip --slim on Linux, or select the installed iPhoneOS.sdk with SDKROOT.'
command -v swift >/dev/null || fail 'Swift 6.4 is required.'
swift --version | python3 -c 'import re,sys; s=sys.stdin.read(); m=re.search(r"Swift version (\d+)\.(\d+)",s); sys.exit(0 if m and tuple(map(int,m.groups())) >= (6,4) else 1)' || fail 'Swift 6.4 or newer is required for the xtool SwiftBuild/XCFramework path.'
version=${NANOCODEX_IOS_VERSION:-0.1.0}
build=${NANOCODEX_IOS_BUILD_VERSION:-$(date -u +%s)}
output="$root/output/ios-linux/$build"
[[ $build =~ ^[1-9][0-9]*$ ]] || fail 'Build must be a positive integer.'
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Version must be major.minor.patch.'
mkdir -p "$output"
# Keep a transcript even on compilation failure. No signing secrets are printed.
exec > >(tee "$output/build.log") 2>&1
printf 'Linux build: %s (%s)\n' "$version" "$build"
swift --version
"$xtool" --version
SDKROOT="$sdk" IPHONEOS_DEPLOYMENT_TARGET=18.0 bash apple/NanocodexVoice/scripts/build-core-linux.sh
sdk_version=$(python3 - "$sdk" <<'PYSDK'
import json, pathlib, plistlib, sys
root = pathlib.Path(sys.argv[1])
if (root/'SDKSettings.plist').exists():
    data = plistlib.loads((root/'SDKSettings.plist').read_bytes())
else:
    data = json.loads((root/'SDKSettings.json').read_text())
print(data['Version'])
PYSDK
)
python3 apple/scripts/prepare-xtool.py --version "$version" --build-number "$build" --sdk-version "$sdk_version"
# Package.swift reads generated JSON outside SwiftPM's tracked manifest inputs.
# Re-plan after preparation while preserving compiled objects and dependencies.
rm -f apple/.build/manifest.pif
args=(dev build --configuration release --ipa)
# Don't leak SDKROOT into host tools and SwiftPM manifest compilation.
# SwiftNIO's stdin registration needs a terminal with some CI transports.
command -v script >/dev/null || fail 'Install util-linux (script) for the xtool terminal transport.'
printf -v build_command '%q ' env -u SDKROOT "$xtool" "${args[@]}"
(cd apple && script --quiet --return --command "$build_command" /dev/null < /dev/null)
mapfile -t ipas < <(find "$root/apple/xtool" -maxdepth 1 -type f -name '*.ipa')
[[ ${#ipas[@]} == 1 ]] || fail 'Expected exactly one IPA from xtool.'
python3 apple/scripts/verify-ios-linux.py "${ipas[0]}" > "$output/structure.json"
kind=unsigned
$sign && kind=signed
if $sign; then
  bash apple/scripts/sign-ios-linux.sh "${ipas[0]}" "$output/Nanocodex-$build-$kind.ipa"
else
  cp "${ipas[0]}" "$output/Nanocodex-$build-$kind.ipa"
fi
cp apple/xtool/generated/membership.json "$output/membership.json"
sha256sum "$output/Nanocodex-$build-$kind.ipa" > "$output/SHA256SUMS"
printf 'Produced %s/Nanocodex-%s-%s.ipa\n' "$output" "$build" "$kind"
if ! $sign; then echo 'Unsigned build: not installable and not published to OTA.'; fi
