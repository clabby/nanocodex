# iPhone builds on Linux

This is an experimental xtool build path for Nanocodex, its share extension,
widgets, and Rust voice library. It produces a full native app, not interpreted
Swift or a web wrapper. It does not invoke macOS, Xcode, `xcrun`, or `lipo`.
The existing Xcode build remains available independently.

**Status:** a complete Linux device build and IPA packaging are validated with
Swift 6.4, xtool 1.20.1 and iPhoneOS SDK 26.2. Binary checks verify ARM64 app and
extension code, the share principal class, the widget's Swift entry point, and
the bundled WebRTC framework. Apple signing trust, phone installation, and
App Intents discovery remain unverified. The default IPA is not installable.

## Setup

Use Linux with sufficient local disk for the Swift toolchain, Xcode archive, SDK
extraction, Cargo and SwiftPM caches. A small ephemeral container can run out of
disk during extraction. Use Swift 6.4 or newer; SwiftBuild support in xtool 1.20
is needed for the app's XCFramework dependencies.

1. Install [Swift for Linux](https://www.swift.org/install/linux/), Rust 1.97,
   Python 3 with Pillow, `zip`, and `util-linux` (the `script` command).
2. Install the Rust device target: `rustup target add aarch64-apple-ios`.
3. Download Xcode's `.xip` from your Apple Developer downloads account, or copy
   an existing `Xcode.app` to Linux. This is an SDK input; Xcode itself is not
   run. Keep it in private storage. The installer accepts either input.
4. Install the pinned xtool release and extract the SDK on Linux:

   ```sh
   bash apple/scripts/install-xtool-linux.sh /path/to/Xcode.xip
   export NANOCODEX_XTOOL="$HOME/.local/share/nanocodex/xtool-1.20.1/squashfs-root/AppRun"
   ```

   `NANOCODEX_XTOOL_PREFIX` changes the install location. The installer checks the
   upstream release SHA-256 and extracts its AppImage without requiring FUSE.

## Build

```sh
ulimit -n 65536
NANOCODEX_IOS_VERSION=0.1.0 NANOCODEX_IOS_BUILD_VERSION=1790650000 \
  bash apple/scripts/build-ios-linux.sh
```

Swift dependency scanning can exceed a Linux shell's default 1,024 open files;
raise the limit before building. Leave space on the system temporary filesystem
as well as the build volume: SwiftBuild may reset `TMPDIR` for child tools.
The package enables Swift cross-import overlays for PhotosUI and Quick Look
SwiftUI APIs. Extension linking retains Objective-C principal classes and uses
the widget bundle's Swift entry point. The wrapper regenerates SwiftBuild's plan
after preparing metadata while retaining compiled objects and dependencies.

The default build is unsigned, allowing compilation without Apple credentials
or a connected iPhone. The script discovers the installed `iPhoneOS.sdk`; set
`SDKROOT` explicitly if multiple SDKs are installed. Only the Rust subprocess
receives that environment variable.

The Rust script cross-compiles `nanocodex-voice-ffi` for `aarch64-apple-ios`, then
writes a device-only XCFramework using Python. It does not require Mac or
simulator slices. Existing Apple builds can regenerate their multi-platform
artifact with their original build script.

The build runs `verify-ios-linux.py` against the produced IPA and rejects empty
extension stubs, missing principal classes, and incorrect widget entry points.
These binary checks do not substitute for testing on the phone.

Build logs, binary verification report, IPA, and SHA-256 are under `output/ios-linux/<build>/`. The staged
project is under ignored `apple/xtool/generated/`. Generated manifests and plists are derived
from the existing app's source configuration; changes to the Xcode project must
also pass the packaging preparation checks. The root SwiftPM lockfile points
to a generated copy of the app’s existing Xcode dependency pins, keeping the
original lockfile unchanged.

## Signing and OTA

The optional `--sign` step uses a separate Linux zsign invocation. xtool 1.20.1's
built-in signer does not preserve the extension entitlement mapping, so the
wrapper does not use `xtool dev build --sign`. The staged configuration retains
the original entitlements for all targets.

Signing requires a private local signing key/certificate and three provisioning
profiles, matching the app, share extension, and widgets. Keep credentials out
of source, logs, and PRs. Install the pinned signer with `apple/scripts/install-zsign-linux.sh` (requires
`g++`, `make`, `pkg-config`, and OpenSSL headers). Set `ZSIGN_PATH` to the printed
binary path. Use `apple/scripts/sign-ios-linux.sh --help` for the private input
paths (`IOS_SIGNING_KEY`, `IOS_SIGNING_CERT`, and the three `IOS_PROFILE_*`
variables), then run `build-ios-linux.sh --sign`. A signed IPA
still requires verification on the actual phone before publishing.

The resulting IPA can feed the existing HTTPS OTA manifest/feed pipeline. This
build script does not publish or change `latest.json`. Validate the resulting
app, extension IDs/entitlements, native libraries, icons, and device installation
before publishing. Siri/Shortcuts metadata and all device-only behavior also
require explicit validation; an executable bundle alone is not feature parity.

## GitHub Actions

`Linux iPhone build` runs packaging and synthetic signing journeys on relevant
PRs. The signing journey uses real ARM64 binaries, temporary synthetic profiles,
and independent OpenSSL CMS checks; it does not use Apple credentials or prove
device installation. Manual dispatch
also performs a real unsigned build using the official Swift Linux container.
Configure `IOS_LINUX_SDK_URL` as a secret pointing to your private Xcode `.xip`
and `IOS_LINUX_SDK_SHA256` as a repository variable with its checksum. The job
fails immediately if either is absent. It retains evidence as an Actions
artifact; it never uploads to TestFlight or publishes OTA.

## Compatibility boundaries

The current app asset catalog contains only its app icon. Preparation creates
legacy iPhone/iPad icon PNGs from the canonical image and rejects additional
asset types until they have explicit Linux handling. This preserves artwork;
icon rendering on the target phone remains a device validation step.

xtool packages the existing transitive WebRTC binary dependency, but the final
IPA must still be checked for its actual iPhone framework and all extensions.

SwiftBuild does not itself replace Apple's App Intents metadata processor.
xtool 1.20.1 does not ship a Linux implementation, and its proposed metadata
extractor is [unmerged](https://github.com/xtool-org/xtool/pull/217). The Swift
intent sources stay included; Siri/Shortcuts discovery and intent-driven
controls are **not validated or claimed complete** by this build route.

“Unsigned” means unprovisioned: xtool can apply ad-hoc signatures to retain
entitlements. Such an IPA is still not an installable OTA release.
