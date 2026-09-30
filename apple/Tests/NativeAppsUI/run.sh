#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
harness="$repo/apple/Tests/NativeAppsUI"
output="$repo/output/native-app-ui"
mkdir -p "$output"
cp -R "$harness/Demo" "$harness/UITests" "$harness/Fixtures" "$output/"
cp "$harness/generate-project.py" "$output/"
# Optional externally generated Swift source fixtures use the same journey labels.
if [[ -n "${NATIVE_APP_FIXTURES:-}" ]]; then
  cp "$NATIVE_APP_FIXTURES/cigarettes.swift" "$NATIVE_APP_FIXTURES/calories.swift" "$NATIVE_APP_FIXTURES/form.swift" "$output/Fixtures/"
fi
holdouts="${NATIVE_APP_HOLDOUTS:-$repo/apple/NanocodexApps/Journeys}"
cp "$holdouts/cigarette-tracker.swift" "$output/Fixtures/generated-cigarettes.swift"
cp "$holdouts/calorie-tracker.swift" "$output/Fixtures/generated-calories.swift"
cp "$holdouts/packing-checklist.swift" "$output/Fixtures/generated-packing.swift"
python3 "$output/generate-project.py"
# Reuse a running iPhone; never create or boot another simulator automatically.
device="${NATIVE_APP_SIMULATOR:-$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; print(next((d["udid"] for ds in json.load(sys.stdin)["devices"].values() for d in ds if d["state"] == "Booted" and "iPhone" in d["name"]), ""))')}"
if [[ -z "$device" ]]; then echo "Boot an existing iPhone simulator or set NATIVE_APP_SIMULATOR." >&2; exit 2; fi
# A surviving XCTest runner can retain its loaded test bundle between local runs.
# Reinstall that disposable runner while preserving the demo's Documents files.
xcrun simctl terminate "$device" dev.nanocodex.nativeapps-ui-tests.xctrunner >/dev/null 2>&1 || true
xcrun simctl uninstall "$device" dev.nanocodex.nativeapps-ui-tests.xctrunner
run="journey-$(date -u +%Y%m%dT%H%M%SZ)"
set --
if [[ -n "${NATIVE_APP_TEST:-}" ]]; then
  set -- "-only-testing:NativeAppsUITests/NativeAppsUITests/$NATIVE_APP_TEST"
fi
set +e
"$repo/scripts/xcodebuild-guard.sh" test \
  -project "$output/NativeAppsDemo.xcodeproj" -scheme NativeAppsDemo \
  -destination "platform=iOS Simulator,id=$device" \
  -derivedDataPath "$output/build" -resultBundlePath "$output/$run.xcresult" "$@" \
  2>&1 | tee "$output/$run.log"
status=${PIPESTATUS[0]}
set -e
xcrun xcresulttool export attachments --path "$output/$run.xcresult" --output-path "$output/$run-attachments" || true
python3 - "$output/$run-attachments" <<'PYSHOTS'
import json,pathlib,re,shutil,sys
root=pathlib.Path(sys.argv[1])
manifest=root/'manifest.json'
if manifest.exists():
    for test in json.loads(manifest.read_text()):
        for attachment in test.get('attachments', []):
            name=attachment.get('suggestedHumanReadableName','')
            if re.match(r'^\d{2}-[a-z-]+_', name):
                source=root/attachment['exportedFileName']
                target=root/'screenshots'/(name.split('_',1)[0]+source.suffix)
                target.parent.mkdir(exist_ok=True)
                shutil.copyfile(source,target)
PYSHOTS
if [[ "$status" -ne 0 ]]; then
  printf 'Failed journey evidence: %s\n' "$output/$run.xcresult" "$output/$run.log" "$output/$run-attachments" >&2
  exit "$status"
fi
container="$(xcrun simctl get_app_container "$device" dev.nanocodex.nativeapps-ui-demo data)"
mkdir -p "$output/$run-state"
cp "$container/Documents/"*.json "$output/$run-state/"
cp "$container/Documents/cigarettes-agent-prompt.txt" "$container/Documents/generated-calories-agent-prompt.txt" "$output/$run-state/"
python3 - "$output/$run-state" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
expected={'cigarettes':{'count':1},'calories':{'total':350,'meals':['Oatmeal: 350 kcal']},'form':{'tasks':['Walk after lunch'],'reminder':True}}
for name, fields in expected.items():
    state=json.loads((root/(name+'.json')).read_text())
    for key,value in fields.items(): assert state.get(key)==value, (name,key,value,state)
smoke=json.loads((root/'generated-cigarettes.json').read_text())
assert len(smoke['smoke.entries'])==1, smoke
assert smoke['smoke.pack.price']=='10.00', smoke
assert smoke['smoke.pack.size']==20, smoke
meal=json.loads((root/'generated-calories.json').read_text())
assert len(meal['meals.log'])==1, meal
assert meal['meals.log'][0]['name']=='Oatmeal', meal
assert meal['meals.log'][0]['calories']==350, meal
assert meal['meals.goal']==2000, meal
packing=json.loads((root/'generated-packing.json').read_text())
assert packing['packing.items']==['Phone charger'], packing
assert packing['packing.packed']==['Phone charger'], packing
assert packing['packing.trip']=='My next trip', packing
prompt=(root/'generated-calories-agent-prompt.txt').read_text()
assert 'Oats and milk' in prompt, prompt
coach=(root/'cigarettes-agent-prompt.txt').read_text()
assert 'Today: 1' in coach, coach
print('Verified file-backed persistence for all six apps and an external-agent request.')
PY
printf 'Evidence: %s\n' "$output/$run.xcresult" "$output/$run-attachments" "$output/$run-state"
