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

Use Linux with Swift 6.4 or newer; xtool 1.20's SwiftBuild support is
needed for XCFramework dependencies. Install Rust 1.97, Python 3 with Pillow,
`curl`, `zip`, and `util-linux` (`flock` and `script`). Install the device target
with `rustup target add aarch64-apple-ios`.

### Reuse a private exported SDK (recommended)

A setup/build runner does **not** need the full Xcode `.xip`. Build a slim export
once on Linux from an existing `Xcode.app` tree, including a previously pruned
tree containing the SDKs/toolchain needed by xtool's builder. The upstream
builder still requires iPhoneOS, iPhoneSimulator, and MacOSX SDK roots. No macOS
execution is involved:

```sh
bash apple/scripts/install-xtool-linux.sh
export NANOCODEX_XTOOL="$HOME/.local/share/nanocodex/xtool-1.20.1/squashfs-root/AppRun"
bash apple/scripts/export-xtool-sdk-linux.sh /private/Xcode.app /private/darwin-sdk.tar.gz
```

The export prints its SHA-256. Store the compressed archive in private storage
and pin that digest separately; do not commit, publish, or upload the SDK as a
public CI artifact. Apple licensing/access requirements still apply. Export
requires space for the slim SDK directory and compressed archive, not another
full Xcode copy. It normalizes tar ownership/timestamps and gzip timestamps for
stable bytes from identical builder output. To target another Linux host CPU,
use `--architecture x86_64` or `--architecture aarch64` during export.

On a fresh runner with the same architecture and xtool version:

```sh
bash apple/scripts/install-xtool-linux.sh
export NANOCODEX_XTOOL="$HOME/.local/share/nanocodex/xtool-1.20.1/squashfs-root/AppRun"
bash apple/scripts/import-xtool-sdk-linux.sh /private/darwin-sdk.tar.gz --sha256 <pinned-sha256>
# Alternatively:
NANOCODEX_IOS_SDK_SHA256=<pinned-sha256> \
  bash apple/scripts/install-xtool-linux.sh /private/darwin-sdk.tar.gz
```

`darwin.xtoolsdk` is a **directory**, produced by `xtool sdk build`, and the
archive contains that directory, with optional export metadata. An installed
`darwin.artifactbundle` is not interchangeable: installation adds the current
host clang headers. Do not rename/compress an installed bundle as an export.
The compressed importer accepts upstream-standard exports too; custom metadata
is optional, but validated when present. It always verifies the pinned checksum,
upstream artifact/SDK/toolset metadata, pinned builder version, and the native
ELF tool architecture before installation. It rejects injected host clang headers
through both the `usr/lib/swift/clang` symlink and `usr/lib/clang/*/include` layout. All archive members are
validated before extraction: traversal, absolute paths, escaping/cyclic links,
link-parent members, special files, and duplicate entries are rejected.

Downloads can use `python3 apple/scripts/xtool-sdk-linux.py download FILE
--sha256 DIGEST`, with a private HTTPS URL in `SDK_URL`. The helper never prints
the URL, discards failed/checksum-invalid partial downloads, and atomically
publishes only verified bytes. Keep tracing (`set -x`) disabled around private
inputs. Credential-bearing URLs must not be passed as CLI arguments.

`NANOCODEX_XTOOL_PREFIX` changes the binary installation location. The installer
checks the upstream release SHA-256 and stages AppImage extraction without FUSE.
SDK installation uses an isolated SwiftPM configuration on the destination
filesystem, preserving the old SDK on validation or installer failure. A locked,
recoverable two-rename directory swap publishes the completed bundle; this is
not a transaction with concurrently running builds, so do not replace an SDK
while builds are using it. An interrupted swap is recovered on the next valid
install attempt. The SDK lives under `XDG_CONFIG_HOME/swiftpm/swift-sdks` when
set, otherwise `~/.swiftpm/swift-sdks`.

### Xcode inputs remain supported

Download Xcode's `.xip` through your Apple Developer account, or copy an existing
`Xcode.app` to Linux, then run either:

```sh
bash apple/scripts/install-xtool-linux.sh /private/Xcode.xip
bash apple/scripts/install-xtool-linux.sh /private/Xcode.app
```

A trusted local `darwin.xtoolsdk` directory from upstream `xtool sdk build` also
works as a direct installer input. Xcode inputs use xtool's own SDK builder/validation; local `.xtoolsdk` directories
also receive the structural/native-tool checks. Compressed inputs additionally
receive archive-member validation and checksum verification. A full `.xip`
requires substantially more extraction space; prefer the reusable export for
routine runners. No signing or publishing occurs during setup.

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

Unsigned packaging uses a bounded lossless DEFLATE9 repacker, checking every member
byte and preserved ZIP metadata; the complete Omarchy IPA is now17.1MB rather
than53.2MB. zsign also requests level9. The independent Linux verifier rechecks
supported code CMS signatures, page/special hashes and resource seals before
signing output is published; it is not Apple's platform policy or device proof.
A Linux-owned private key and public CSR can be prepared with
`release-ios-linux.sh init-signing`; Apple must still issue its certificate and
matching profiles. No Mac key export is needed for this route.

The resulting IPA can feed the existing HTTPS OTA manifest/feed pipeline. This
build script does not publish or change `latest.json`. Validate the resulting
app, extension IDs/entitlements, native libraries, icons, and device installation
before publishing. Siri/Shortcuts metadata and all device-only behavior also
require explicit validation; an executable bundle alone is not feature parity.

## Local operation (no CI required)

The local build, signing, and OTA staging/publication route runs directly on the
Linux Hand. It does not invoke GitHub Actions, require repository secrets, or
use a Mac. See [the local release guide](local-release.md) for commands and the
real signing/device-validation prerequisites. Existing Apple/CI workflows stay
independent; this route does not change or depend on them.

## Compatibility boundaries

The current app asset catalog contains only its app icon. Preparation creates
legacy iPhone/iPad icon PNGs from the canonical image and rejects additional
asset types until they have explicit Linux handling. This preserves artwork;
icon rendering on the target phone remains a device validation step.

xtool packages the existing transitive WebRTC binary dependency, but the final
IPA must still be checked for its actual iPhone framework and all extensions.

SwiftBuild does not itself replace Apple's App Intents metadata processor.
xtool 1.20.1 does not ship a Linux implementation. Its proposed metadata
extractor is [closed and unmerged](https://github.com/xtool-org/xtool/pull/217),
not an available processor fix. The validated unsigned IPA has no
`Metadata.appintents`, although the intent sources compile. Auditing that
candidate against compiler output exposed lost shortcuts (six of seven),
parameter/entity/query type information, and explicit authentication policies;
it is not safe to integrate as a feature-parity solution.

`audit-appintents-linux.py` reads compiler constants and optional IPA/candidate
metadata without generating or injecting it. Run
`python3 apple/scripts/test-appintents-linux.py` for its synthetic checks; these
are auditor tests, not Siri or phone-discovery tests. Siri/Shortcuts indexing,
entity queries, authentication semantics, and intent-driven controls remain
**not validated or claimed complete** by this build route. Closing the gap
requires a verified processor and signed, installed-device discovery tests.

`appintents-linux.py` is a separate offline lossless compiler-AST analyzer,
comparison/calibration tool and exact-reference replayer. Real paired Mac compiler
constants match the Linux ASTs, but unknown Runtime values, complete source/context
bindings and private metadata/NLU synthesis are not implemented. It is deliberately
not wired into packaging. Its tests and sanitized captured public metadata are
in `apple/xtool/appintents-fixtures`; they do not close the device-discovery gap.

“Unsigned” means unprovisioned: xtool can apply ad-hoc signatures to retain
entitlements. Such an IPA is still not an installable OTA release.
