# Agent thread notifications

Nanocodex keeps generic turn failures, running work, and changing progress inside
the conversation. A newly observed unread response from a conversation observed
running can publish one passive Notification Center receipt while the app is in
the background. It does not raise a banner or play a sound. Publishing consumes
the observed run; later outcomes need another observed run. Historical unread
responses do not notify on first launch.

Only an unconfirmed outgoing message can raise an active, silent notification:
its card explains that delivery needs a retry. Its revision follows the failed
message identities, so unrelated agent turns cannot repeatedly raise the same
alert. Outcomes observed while the app is open are consumed without notifying
later, including after relaunch. Notification delivery racing foreground entry
is also suppressed by the native delegate.

Each card contains its conversation title, status, and a bounded excerpt.
Message inputs, reasoning, and raw tool arguments/results never appear.
Tapping a card selects that conversation. Clearing it does not stop the agent.
iOS groups by a stable account-and-conversation identifier.

`AgentNotificationController` serializes updates. `AgentNotificationLedger`
persists identifiers and content hashes, not message bodies. Clearing a
notification suppresses further updates for that revision, including after
relaunch. Reviewed/deferred responses, verified removal, and sign-out remove
corresponding notifications. Unchecked cards during restoration retain receipts.
Notifications from another account are removed when the account changes.

Links carry account scope and agent ID. They open only a conversation present
in the current account, including after restoration. Opening a notification
cannot send, stop, or approve work. The notification delegate is installed during
app initialization so taps can be retained while saved-account restoration runs.

## System task UI

Ordinary chat Send and Retry submit cloud work without requesting an iOS
`BGContinuedProcessingTask`. Merely enabling this phone as a Hand no longer
creates system progress/failure cards for every conversation. The explicit
**Run Agent Task** shortcut retains its device-runtime path. Without that runtime,
phone tools follow the existing foreground and short background-grace limits;
the durable cloud turn continues when local observation stops.

Recording Live Activities retain their controls and lifetimes. They are separate
from the retired aggregate agent activity and the OS-owned task progress UI.

## Freshness and migration

Regular agent streams pause when the app backgrounds. Notifications depend on
locally observed outcomes, not guaranteed background updates. There is no APNs
token registration or server publisher in this change. Reliable changes while
the phone remains locked or the app is terminated require that delivery path.
Notifications from the previous policy are removed at launch and activation,
independently of account restoration. The new ledger starts without the previous
policy's indefinitely tracked conversations.

The earlier aggregate Live Activity is no longer started. The controller ends
any surviving aggregate activities at launch, on every foreground activation,
and during notification updates, independently of account restoration. The existing widget extension and
ActivityKit attributes remain available for that migration. The bounded
`AgentActivitySnapshot` projection supplies the per-conversation excerpts.

Apple documents [notification grouping](https://developer.apple.com/documentation/usernotifications/unmutablenotificationcontent/threadidentifier)
and [dismissal callbacks](https://developer.apple.com/documentation/usernotifications/unnotificationdismissactionidentifier).

## Validation

```sh
swift test --package-path apple/InboxCore
bash scripts/xcodebuild-guard.sh -project apple/NanocodexInbox.xcodeproj -scheme NanocodexInbox \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
bash scripts/xcodebuild-guard.sh -project apple/NanocodexInbox.xcodeproj -scheme NanocodexInbox \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -only-testing:NanocodexInboxUITests/AgentNotificationUITests \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

`AgentThreadNotificationTests` covers independent receipts, historical outcome
suppression, dismissal persistence, foreground outcomes, delivery identity, new turns, late callbacks, restoration,
removal, and queue/privacy projection. `AgentActivityTests` covers the underlying
attention policy, excerpts, payload bounds, and account-scoped links.

The native UI journey uses explicitly enabled demo fixtures to verify running
threads remain silent across foreground/background transitions and warm/cold
URL routing still works. Ordinary demo journeys do not create notifications.
Simulator evidence does not establish physical-device delivery or APNs behavior.
