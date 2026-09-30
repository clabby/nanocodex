#!/usr/bin/env bash
# Native notes/transcript UI -> real account proxy/Worker -> persisted local D1.
# Run on macOS with workspace dependencies installed (pnpm install).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
output="${NANOCODEX_MEETING_EVIDENCE_DIR:-$root/output/native-meetings/ios}"
mkdir -p "$output"
worker=""; device=""; was_booted=1
cleanup() {
  if [[ -n "$worker" ]]; then kill "$worker" 2>/dev/null || true; wait "$worker" 2>/dev/null || true; fi
  if [[ -n "$device" && "$was_booted" == 0 ]]; then xcrun simctl shutdown "$device" 2>/dev/null || true; fi
}
trap cleanup EXIT
if [[ "${NANOCODEX_MEETING_USE_EXISTING_FIXTURE:-0}" != 1 ]]; then
  node js/managed/scripts/meeting-library-fixture.mjs --port 8797 --persist "$output/worker-state" > "$output/worker.log" 2>&1 &
  worker=$!
fi
for attempt in $(seq 1 60); do
  if curl --silent --fail http://127.0.0.1:8797/__fixture/provider >/dev/null; then break; fi
  if [[ -n "$worker" ]] && ! kill -0 "$worker" 2>/dev/null; then cat "$output/worker.log"; exit 1; fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:8797/__fixture/provider >/dev/null
# Reuse a single existing simulator; no parallel UI runs or extra devices.
device="${NANOCODEX_MEETING_SIMULATOR_ID:-$(xcrun simctl list devices available -j | python3 -c 'import json,sys; print(next(d["udid"] for ds in json.load(sys.stdin)["devices"].values() for d in ds if "iPhone" in d["name"] or "Mobile UX" in d["name"]))')}"
was_booted=$(xcrun simctl list devices available -j | DEVICE="$device" python3 -c 'import json,os,sys; print(int(next(d["state"] for ds in json.load(sys.stdin)["devices"].values() for d in ds if d["udid"]==os.environ["DEVICE"])=="Booted"))')
export NANOCODEX_MEETING_JOURNEY_ORIGIN=http://127.0.0.1:8797
scripts/xcodebuild-guard.sh -project apple/NanocodexInbox.xcodeproj -scheme NanocodexInbox \
  -destination "platform=iOS Simulator,id=$device" -derivedDataPath "${NANOCODEX_MEETING_DERIVED_DATA:-$output/build}" \
  -clonedSourcePackagesDirPath "${NANOCODEX_MEETING_PACKAGES_DIR:-$output/packages}" \
  -resultBundlePath "$output/meetings-$(date +%Y%m%dT%H%M%S).xcresult" \
  -only-testing:NanocodexInboxUITests/InboxUITests/testMeetingsPersistAndSyncNativeNotes \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test 2>&1 | tee "$output/ui-test.log"
