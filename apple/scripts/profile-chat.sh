#!/usr/bin/env bash
# Synthetic iOS chat profiling; run from any directory in the checkout.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"
: "${CHAT_PROFILE_DEVICE:?Set CHAT_PROFILE_DEVICE to an existing iOS Simulator UDID}"
derived=${CHAT_PROFILE_DERIVED_DATA:-output/ChatProfileDerivedData}
evidence=${CHAT_PROFILE_OUTPUT:-output/chat-profile-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$evidence"
scripts/xcodebuild-guard.sh -project apple/NanocodexInbox.xcodeproj -scheme NanocodexInbox \
  -configuration Debug -destination "platform=iOS Simulator,id=$CHAT_PROFILE_DEVICE" \
  -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  build-for-testing > "$evidence/build.log" 2>&1
run=$(python3 - "$derived" <<'PY'
import pathlib, plistlib, sys
paths = sorted(pathlib.Path(sys.argv[1]).glob('Build/Products/NanocodexInbox_*.xctestrun'))
if len(paths) != 1:
    raise SystemExit(f'Expected one simulator test run; found {len(paths)}')
path = paths[0]
run = plistlib.loads(path.read_bytes())
targets = ([t for c in run['TestConfigurations'] for t in c['TestTargets']]
           if 'TestConfigurations' in run else [v for k,v in run.items() if not k.startswith('__')])
for target in targets:
    if target.get('IsUITestBundle'):
        target.setdefault('EnvironmentVariables', {})['NANOCODEX_INBOX_PERFORMANCE'] = '1'
        target['PreferredScreenCaptureFormat'] = 'screenRecording'
        target['SystemAttachmentLifetime'] = 'keepAlways'
        target['UserAttachmentLifetime'] = 'keepAlways'
output = path.with_name('ChatProfile.xctestrun')
output.write_bytes(plistlib.dumps(run))
print(output)
PY
)
status=0
scripts/xcodebuild-guard.sh -xctestrun "$run" \
  -destination "platform=iOS Simulator,id=$CHAT_PROFILE_DEVICE" \
  -resultBundlePath "$evidence/profile.xcresult" \
  -only-testing:NanocodexInboxUITests/InboxUITests/testPerformanceChatTimelineScrolling \
  -only-testing:NanocodexInboxUITests/InboxUITests/testPerformanceStreamingMarkdownAndTools \
  -only-testing:NanocodexInboxUITests/InboxUITests/testPerformanceDemoConversationRendering \
  test-without-building > "$evidence/test.log" 2>&1 || status=$?
if [[ -d "$evidence/profile.xcresult" ]]; then
  xcrun xcresulttool export metrics --path "$evidence/profile.xcresult" --output-path "$evidence/metrics"
  xcrun xcresulttool export attachments --path "$evidence/profile.xcresult" --output-path "$evidence/attachments"
fi
printf 'Profile evidence: %s\n' "$evidence"
exit "$status"
