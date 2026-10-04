# iPhone delivery

The Mac OTA path builds the `xyz.paradigm.centaur` app with the Mac's Xcode
signing credentials and serves it at
https://nanocodex-ios-updates.gakonst.workers.dev. The iPhone can download over
cellular or Wi-Fi; the Mac and phone do not need to share a network. iOS performs
the installation after the user confirms its prompt.

## Build and publish

Use a Mac with Xcode, Python 3.9 or later, the repository's pnpm dependencies,
Cloudflare deployment access, and working automatic signing for the app, share
extension, and widget extension. The target device must be registered in each
development provisioning profile. A development-signed installation also needs
Developer Mode enabled on the phone. Keep signing credentials in the Mac's
normal keychain and Xcode account settings.

Choose a monotonically increasing positive integer build number. Use one
persistent asset directory outside every repository checkout; keep this entire
directory between publications and deployments. It contains the full release
history. Do not use a temporary directory or commit exported IPAs.

```sh
# Replace these example values with your next build and chosen persistent path.
bash apple/scripts/build-mac-update.sh 123 "$HOME/Library/Application Support/Nanocodex/ota-assets" \
  --deploy --notes 'Improved iPhone updates'
```

The script rebuilds the shared voice core, performs a Release archive, exports
with Xcode's `debugging` method and automatic signing, validates the IPA, and
publishes it. The printed archive/export directory is retained for diagnosis. Xcode may need
to refresh profiles through its configured account. Pass `--device-udid` or set
`NANOCODEX_DEVICE_UDID` privately to require that every profile includes a
specific phone. No device identifier is stored in this repository or feed.

To validate and prepare an existing exported IPA without deploying:

```sh
python3 apple/scripts/publish-mac-update.py --ipa /path/to/Nanocodex.ipa \
  --assets-dir "$HOME/Library/Application Support/Nanocodex/ota-assets"
```

Add `--deploy` to invoke `pnpm --filter nanocodex-managed-service exec wrangler deploy --config
apple/ota/wrangler.jsonc --assets ASSETSDIR`. `--config` can specify another
Wrangler configuration for the same publication origin. Preparation changes the
local feed only; deployment must succeed before the phone can see it. On a
failed deployment rerun with the same IPA and asset directory. Do not run
independent publishers with different asset directories: the local lock and
latest-build policy protect one persistent directory, not competing hosts.

Validation checks the expected bundle ID, a numeric build, strict code signatures,
and unexpired profiles for every app and extension. App Store-only profiles are
rejected. Specifying the device additionally checks installation eligibility in
every profile. An existing build cannot be replaced with different IPA bytes or
manifest metadata, and `latest.json` cannot move to a lower build. Keep a backup
of the asset directory; deploying an incomplete directory removes older assets
from the deployed site. If the directory is lost, restore it before publishing.

## Install and update

For the first installation, open the site above in **Safari on the registered
iPhone**, tap **Install Nanocodex**, and accept the iOS installation prompt.
After bootstrapping, Nanocodex checks on foreground entry and once per minute
while active. A prominent banner above the conversation offers **Install** when
a newer build is published. **Settings → Nanocodex updates** also provides manual
checking and installed-build details. Checks pause while the app is inactive;
this is not a background push notification or a silent installation. iOS controls the final installation; opening the
installation link does not itself prove completion. Expired profiles need a new
signed build. Cellular downloading still depends on the phone's connectivity
and data settings.

The static feed has this schema (`notes` is optional):

```json
{
  "version": "1.0",
  "build": "123",
  "bundle_id": "xyz.paradigm.centaur",
  "manifest_url": "https://nanocodex-ios-updates.gakonst.workers.dev/builds/123/manifest.plist",
  "published_at": "2026-09-20T12:00:00Z",
  "notes": "Improved iPhone updates"
}
```

Each immutable `/builds/<build>/` contains `Nanocodex.ipa`, `manifest.plist`, an
installation page, and `sha256.txt`. The root page and `latest.json` use
`Cache-Control: no-store`; build assets use immutable caching. `_headers` also
sets the IPA and plist content types and disallows indexing. Anyone with an
asset URL can download it; signing and device provisioning control whether iOS
can install it. Check the hosting plan's per-asset size limit before deployment.

Run the focused policy tests with:

```sh
python3 apple/scripts/test-publish-mac-update.py
```

## Direct installation over Wi-Fi or USB

Use the paired Mac and iPhone on the same Wi-Fi network, or connect by USB.
Keep the phone unlocked and Developer Mode enabled. Being on the same network
alone does not prove the paired device is reachable: check discovery first.

```sh
xcrun devicectl list devices
```

With the shared Rust voice core built as described in `apple/README.md`, build
with the Mac's existing signing configuration and install onto the exact paired
phone identifier reported above:

```sh
scripts/xcodebuild-guard.sh -project apple/NanocodexInbox.xcodeproj \
  -scheme NanocodexInbox -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath output/ios-device \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic \
  "CURRENT_PROJECT_VERSION=$(date -u +%s)" build
xcrun devicectl device install app --device DEVICE_IDENTIFIER \
  output/ios-device/Build/Products/Release-iphoneos/Nanocodex.app
xcrun devicectl device info apps --device DEVICE_IDENTIFIER
```

Do not choose another paired phone merely because it is available. Verify the
installation receipt and the installed bundle's build number before reporting an
update. A connection failure or lost receipt is not proof of installation; read
back the device state before retrying an uncertain install. App launch/UI checks
are separate from successful installation and may require an unlocked phone.

Local signing, direct installation and the signed OTA feed do not require CI.
The normal nightly CLI/native release workflow is independent of iPhone delivery.

## Build and sign on Linux

A Mac is not required for the [local Linux build and signing path](../apple/xtool/local-release.md).
Reuse the installed Swift/xtool/Apple SDK and existing private signing directory.
`bash apple/scripts/release-ios-linux.sh build-unsigned` produces an IPA under
`output/ios-linux/BUILD/`; this unsigned file cannot be installed on the phone.

Linux can generate a protected private key and public certificate signing request.
Apple must issue the matching certificate and profiles for the app, share and
widget extensions, covering the intended iPhone. Generating another local key
does not issue Apple credentials. A browser login does not authenticate xtool.
Saved Vault use is described in the [Vault request API](vault-requests.md); its HTTP/JWT operations do not implement
xtool's GrandSlam password authentication or native artifact signing.
The linked guide describes the required local signing inputs and `build-signed`.

Linux OTA staging checks provisioning and signature integrity, but does not prove
installation. Its automatic `--deploy` remains disabled pending complete remote
asset reconciliation. Follow the guide's manual publication prerequisites and
verify the installed build on the intended phone; preserve the entire immutable
feed history.

## Hand work while the phone is locked

With the device Hand enabled, sending or retrying a chat task while the app is
active requests iOS 26 continued-processing time. A message steering a running
turn observes that existing turn without submitting it again. The Hand remains
connected while at least one task has granted runtime, including after screen
lock. Progress comes from actual turn events, and completion releases runtime.

If continued runtime is unavailable, the Hand uses the short background window
provided by iOS; the system expiration handler ends that window. Expiration
stops local observation and disconnects the Hand when no other runtime remains.
It does not cancel the cloud turn. Opening the app reconnects the Hand. Idle
phones have only system-scheduled refresh windows; this is not an always-on
service, and force-quitting ends background execution. Tools needing foreground
permission prompts or protected resources may still require unlocking.

Physical-device verification: on iOS 26, enable the Hand and send a task that
reads a workspace file after a delay exceeding 30 seconds. Lock the phone after
sending; confirm system progress and a successful remote tool result. Repeat
with overlapping tasks, finish one, and verify the second still has access.
Finally let background time expire and reopen: the Hand should reconnect without
resubmitting or cancelling the accepted cloud turn. Simulator and package tests
do not establish a real device's runtime grant or locked-state availability.
