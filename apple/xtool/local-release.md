# Local Linux build, signing and OTA staging

This path builds and signs on Omarchy/Linux; it does not invoke GitHub Actions,
macOS, an Apple login, or CI deployment. The Linux build needs an existing local
Swift 6.4 toolchain, xtool, Rust iOS target and private reusable Apple SDK. Source
your isolated `env.sh` first; see the SDK guide for import/export. No SDK,
certificate, key, profile or generated IPA belongs in Git.

```bash
bash apple/scripts/release-ios-linux.sh build-unsigned
# Only after independently provisioning real local signing inputs:
bash apple/scripts/release-ios-linux.sh build-signed
```

`build-signed` delegates to the existing Linux build/sign scripts. It requires
`ZSIGN_PATH`, `IOS_SIGNING_KEY`, `IOS_SIGNING_CERT`, `IOS_PROFILE_MAIN`,
`IOS_PROFILE_SHARE`, `IOS_PROFILE_WIDGETS` and optionally `IOS_DEVICE_UDID`.
The key must be an unencrypted PEM local file owned by you, mode 0600/0400.
Do not put credentials, device identifiers or their file contents in shell logs,
command arguments, commits, or this guide. No signing was performed while adding
this local release path.

## Offline staging, not Apple validation

`publish-ios-linux.py` reuses the platform-independent manifest, page, immutable
build policy and persistent preparation code from `publish-mac-update.py`, **not**
its macOS `codesign`/`security` validator. It independently rechecks the signed IPA
against its Linux `.signing.json` SHA256 and pinned signer revision, three bundle
IDs/build/version, arm64 code and extension entry/class structure, WebRTC, embedded
profile CMS integrity, certificate fingerprint/validity, team/device compatibility,
profile dates, App Groups, embedded signed entitlement equality and resource-seal
presence. Known synthetic certificate markers are rejected. Metadata is frozen
from an input copy while checking to prevent source-IPA changes between hashing
and staging. Python optimization is rejected because the Linux binary inspector
uses assertions.

These are **structural/integrity checks only**. OpenSSL `cms -noverify` does not
verify Apple trust. This is not full code-page/resource hash verification, Apple
certificate chain/revocation checks, successful installation, or feature testing.
The signing receipt is hash-binding local evidence, not signed provenance; a
forged receipt and self-issued certificate are not cryptographically ruled out.
A synthetic IPA without real-device observation must never be deployed. Offline
staging does not promote an IPA to Apple-trusted or device-validated status.

Staging only accepts an existing complete persistent assets tree **outside the
repository**, preserving prior immutable builds. For the already-existing OTA
site it deliberately refuses empty/fresh assets. Obtain the full prior assets
from the existing canonical release store and independently reconcile them with
the current live site. Downloading `latest.json` alone cannot prove complete
history. Supply a private JSON baseline receipt with `status` set to
`complete-live-snapshot`, `origin` matching the configured OTA origin,
`observed_at` (UTC ending Z), an identified `observer`, and `files`: a map of
**every** relative asset path to its SHA256. No generated baseline assertion is
provided: the operator must actually establish complete coverage. The tool
checks every on-disk asset hash but cannot independently authenticate this
operator assertion or detect later concurrent remote changes.

```bash
bash apple/scripts/release-ios-linux.sh stage \
  --ipa /private/releases/Nanocodex-signed.ipa \
  --assets-dir /private/persistent/nanocodex-ota \
  --baseline-receipt /private/observations/live-assets.json \
  --upload-dir /private/persistent/nanocodex-ota-upload
```

`--upload-dir` is optional and must be a NEW external directory, separate from
both repo and archive. After portable preparation, the publisher invokes:

```bash
python3 apple/scripts/chunk-ios-ota.py \
  --source /private/persistent/nanocodex-ota \
  --destination /private/persistent/nanocodex-ota-upload
```

The helper atomically creates the separate all-history upload tree; the
archive remains untouched. Existing destinations are refused rather than
silently merged or overwritten. If chunk generation fails, the validated
archival release may already be staged, but no deployment has occurred; inspect
the error and recover with the helper using a new destination. Never use the
archival directory as the Wrangler `--assets` argument.

Signing receipt defaults to `IPA.signing.json`; use `--signing-receipt` to select
its original unchanged receipt. Mismatched receipts, malformed/unsigned IPAs,
unknown signer revisions, profile/entitlement discrepancies, symlinks,
version/build downgrade and immutable overwrite fail closed. Staging updates
local `latest.json`/install page while retaining all prior build directories.
Do not add private receipts to public assets. IPA profiles include provisioned
device identifiers; restrict local access and use this feed only for its intended
registered-device distribution.

## Real-device confirmation and manual local deployment

Install the **exact signed SHA256** on an authorized registered iPhone, launch it,
and exercise share-extension capture, widgets, App Group sharing, voice, and
App Intents/Siri/Shortcuts. Record failures honestly. The Linux App Intents
metadata check and binary structure do not prove Siri/Shortcuts integration.
Create a private manual observation receipt only after actual user observations:

- `status`: `device-tested`; `sha256`: exact signed IPA hash
- `version`, `build`, `tested_at` (UTC ending Z), `observer`, `device_udid`
- `observations`: concrete observed journeys/results, not an automated assertion
- `checks`: `installation`, `app_launch`, `share_extension`, `widgets`,
  `app_groups`, `voice`, `app_intents`, each true **only when actually observed**

Optionally pass it to staging as `--device-test-receipt`. The receipt's hash,
version/build and device/profile matching are checked. Synthetic observations
are refused. This remains a **user assertion**, not independent proof or Apple
trust validation. No receipt is invented or automatically filled in.

`--deploy` deliberately refuses **without doing any network write**, even if a
receipt is supplied. Safe automatic reconciliation of the entire current remote
asset set has not been validated. Wrangler asset deployment replaces the asset
set; deploying a fresh tree can silently remove older releases. After manually
reviewing the real-device observations, re-reconciling **all** current live assets
and checking nothing changed remotely since the baseline, a separately authorized
operator must first generate a separate filtered/chunked upload tree containing
**all** historical builds. The archival full-IPA tree must NEVER be deployed
directly: Cloudflare Static Assets limits individual files to 25 MiB, whereas
the independently built IPA is approximately 51 MB. The OTA Worker reconstructs
the unchanged same-origin IPA URL from asset chunks no larger than 24 MiB.
The chunk helper must leave archival IPAs unchanged so immutable/idempotent
staging continues using the existing portable preparation semantics.

After inspecting the complete generated upload tree, deploy locally with the
repository-pinned Wrangler:

```bash
# From repo root, dependencies previously installed from frozen pnpm lockfile.
pnpm --filter nanocodex-managed-service exec wrangler --version
# Require Wrangler 4.127.1, matching js/managed/package.json and pnpm-lock.yaml.
# Review apple/ota/wrangler.jsonc target/account and entire asset inventory.
pnpm --filter nanocodex-managed-service exec wrangler deploy \
  --config apple/ota/wrangler.jsonc --assets /private/persistent/nanocodex-ota-upload
```

Do not use `pnpm dlx`, `npx` or an unpinned global Wrangler. Do not deploy until
both full-history preservation and actual device results are established.
Already-authorized local Cloudflare access is required; this wrapper never
changes authorization/configuration. Verify the live new immutable IPA hash,
manifest, latest pointer and **prior** release assets after publication. No live
deployment, real signing, or Apple-device validation was performed for this code.

## Local evidence

```bash
python3 apple/scripts/test-publish-ios-linux.py
```

`output/ios-linux-local-publish/journeys.log` records production-CLI refusal
journeys and persistent-feed policy checks. Negative paths use actual production
receipt/argument validation. Successful staging/policy journeys explicitly mock
only the unavailable signed Apple IPA input validator in a child process; they
prove preservation/downgrade/immutable policy, **not** signer, Apple trust or real
installation. No production bypass option is added and no network write occurs. The
publisher's real `--upload-dir` integration also invokes the actual chunk helper
on a synthetic 49 MiB + 3-byte candidate (only its signed-input validator is
mocked): three <=24 MiB chunks reconstruct the exact full SHA256, archival full
IPAs and prior builds are retained, the large upload IPA is absent, manifests
remain unchanged, and existing upload destinations are refused. This is chunk
transport/staging evidence, not successful device installation or deployment.

## Reproduced on Omarchy (2026-09-30)

A fresh complete build of the app, share extension, widgets, Rust voice library
and WebRTC finished on Omarchy in **321.027 seconds**, without macOS or CI.
Build `1790730578` produced a 53,161,894-byte **unsigned/unprovisioned** IPA:
`12cccbefc357b0af4028f4c443ef897f12004ac4c144b56e0fdbcbdbb1e5dbff`.
All three executables passed structure checks; two deliberate widget corruptions
(empty code and wrong entry point) were rejected. Three synthetic zsign CMS
signatures and eight signing failure/recovery controls passed; these are not real
Apple signing results. SDK import/export passed 33 CLI journeys, including the
actual pinned AppImage extraction. App Intents audit tests passed, but all three
built bundles still lack `Metadata.appintents`: Siri/Shortcuts parity is not proven.

The chunk helper passed seven tests including the fresh IPA, source mutation,
symlink/special-file rejection and atomic no-overwrite races. Its measured child
peak RSS was about 33 MiB for a synthetic 51 MiB input. The Worker passed 45 native
stream/HTTP-semantic tests, including missing/invalid metadata, corrupt/truncated/
overlong chunks, cancellation, Range and conditional requests. **14 actual local
Wrangler HTTP journeys** returned the full fresh IPA with its exact SHA256,
cross-chunk/suffix ranges, HEAD, ETag and hidden internal paths. This used
Wrangler 4.127.1/workerd locally, not a deployment or phone installation.
`compatibility_date` is 2026-09-04, supported by that pinned workerd.

Reproduce transport checks with a NEW external fixture directory:

```bash
python3 apple/scripts/test-chunk-ios-ota.py --fixture-dir /private/new-ota-fixture
node apple/ota/worker.test.mjs /private/new-ota-fixture
# Actual local server; no authentication, CI, or remote publish:
pnpm --filter nanocodex-managed-service exec wrangler dev \
  --config apple/ota/wrangler.jsonc --assets /private/new-ota-fixture \
  --local --ip 127.0.0.1 --port 8791
```

The stream authenticates each <=1 MiB block before releasing it. ASSETS may omit
Content-Length; actual streamed length/EOF remains checked. A mid-stream integrity
failure aborts the response (headers already sent cannot become a 503). Production
Apple OTA behavior, deployed Worker limits/performance, and device installation
remain untested. Signing material, private SDKs, observation receipts and device
identifiers are not included in the repository or public test artifacts.
