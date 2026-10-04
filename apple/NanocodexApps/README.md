# NanocodexApps

A SwiftSyntax parser, bounded interpreter, and native SwiftUI renderer for generated Swift apps. Source stays Swift from authoring through execution. The host supplies persisted JSON and the asynchronous agent service. See [AUTHORING.md](AUTHORING.md) for the supported source contract and limits.

The native renderer supports iOS 17 and macOS 14. The parser, interpreter, JSON preflight, and journey CLI also run on Linux. Build with Swift 6.2 or later, matching the pinned SwiftSyntax 602 dependency. On Linux the package uses [Swift Crypto](https://github.com/apple/swift-crypto) for SHA-256 and [OpenCombine](https://github.com/OpenCombine/OpenCombine) for observable session state. Their product dependencies are conditional on Linux; Apple targets retain SDK CryptoKit and Combine.

## Embed an app

```swift
import NanocodexApps

let host = NativeAppHost(
    loadState: { try await storage.load() },
    saveState: { values in try await storage.save(values) },
    runAgent: { prompt in try await agent.run(prompt) }
)
let session = try NativeAppSession(source: source, host: host)
try await session.start()
// In your SwiftUI view:
NativeAppView(session: session)
// When the app is closed:
session.invalidate()
```

The optional `NativeAppView(session:background:)` background lets the host supply its shared adaptive surface; omitting it uses the platform system background. The renderer supplies semantic body text and the same neutral primary tint as the Inbox, while app-authored modifiers remain effective.

Session and view operations run on the main actor. `NativeAppSession.validate(source:)` validates source without executing it. `AppValue` encodes ordinary JSON strings, numbers, booleans, nulls, arrays and objects. `@Persisted` keys survive session restarts; `@State` values remain local to the session. Host failures and runtime limits appear in `session.diagnostic` and in the native view. Failed actions restore the preceding state.

## Run a public journey

From the repository root on macOS or Linux:

```sh
swift run --package-path apple/NanocodexApps native-app-journey --help
swift run --package-path apple/NanocodexApps native-app-journey --self-test
```

To capture the actual SwiftUI controls, run on macOS with a graphical session:

```sh
swift run --package-path apple/NanocodexApps native-app-journey --self-test \
  --screenshot output/native-app-journey.png
```

No arguments also runs the self-test. It parses complete Swift source and exercises the public session API: rendered buttons and bindings, records, functions, loops, on-disk JSON, restart, asynchronous `Agent.run`, invalid source, step and recursion limits, action rollback, an actual filesystem save failure, repair and reopen. It also checks repeated input, 20 overlapping binding tasks against delayed real JSON saves, saved ordering and reopen, and invalidation during a pending agent response. Additional journeys reject agent requests in initializers/functions/rendering before host access, verify post-agent-failure recovery warnings and host receipt lifecycle, exercise collection paging without discarding history, ensure render caches refresh after edits and preserve UUID identity, and observe the main actor servicing another task while interpreted work runs to its finite budget. Only the external agent response is stubbed. `PASS` assertions, control trees, diagnostics, host calls and `ContinuousClock` timings are printed. The `EVIDENCE` line identifies a retained temporary directory containing reproducible source fixtures and JSON state. Capture stdout/stderr with your CI artifact collection; generated evidence does not belong in source control.

Run any supported source with a real state file:

```sh
swift run --package-path apple/NanocodexApps native-app-journey \
  --source ReadingTracker.swift --state output/reading-state.json \
  --set title '"The Odyssey"' --action 'Add book' \
  --set title '"Dune"' --action 'Add book' \
  --agent-response 'Try The Left Hand of Darkness next.' \
  --action 'Suggest a next read' --screenshot output/reading.png
```

The example uses the `ReadingTracker` in AUTHORING.md. Repeat `--set NAME JSON` and `--action TITLE` freely: operations execute in the supplied order, against the current rendered controls. A button title must identify exactly one enabled button. `--set` requires a rendered binding; JSON strings need their JSON quotes inside the shell quotes. Arrays and objects are ordinary JSON too. Missing state files use source defaults; malformed existing state fails instead of silently resetting data. Writes are atomic.

`--agent-response` configures the local host's asynchronous external service stub; omitting it causes an explicit error when source calls `Agent.run`. This CLI does not contact a production agent. `--screenshot` uses `NSHostingView<NativeAppView>` and AppKit to save a 900 × 1100 point PNG of actual native controls after all operations. Screenshot rendering requires a macOS graphical session; pixel dimensions follow the display scale. Captures use a light appearance, opaque window background, and the renderer’s neutral native controls for consistent local and CI evidence. Without that flag, journeys assert the public interpreter control tree without requiring a visible window. Linux runs the same interpreter and persistence journeys; it does not render SwiftUI controls or validate their visual appearance. `--screenshot` fails explicitly on Linux. Errors exit nonzero.

Run the independently authored tracker holdouts through the executable:

```sh
swift build --package-path apple/NanocodexApps --product native-app-journey
python3 apple/NanocodexApps/Journeys/run.py \
  --binary "$(swift build --package-path apple/NanocodexApps --show-bin-path)/native-app-journey" \
  --output output/native-app-holdouts/verified
```

The runner retains source inputs, real JSON state, CLI commands, and control-tree traces under the selected output directory.

## Preflight generated source without saving

`await NativeAppPreflight.validate(json:)` runs the same `NativeAppSession` parser,
initializers, interpreter and render-tree builder with isolated in-memory state.
The native Swift Hand publishes this as `validate_app` on both supported Apple
platforms. No workspace or production app data is read or written. The validator
never dispatches a live agent request; `agent_response` supplies an explicit
fixture, and an attempted `Agent.run` without one fails.

The JSON input requires `runtime: "swift-v1"` and `source`. Optional `state` is a
persisted JSON object. Optional `steps` contains at most 32 ordered operations:

```json
[
  {"action": "set", "binding": "title", "value": "The Odyssey"},
  {"action": "tap", "title": "Add book"},
  {"action": "expect", "text": "The Odyssey"},
  {"action": "reopen"}
]
```

Button titles must identify one enabled rendered button; bindings must belong to
an enabled rendered control. `expect` matches exact rendered `Text`. Reopen
creates a new session from the in-memory saved state and resets session-only
values. A final reopen is always checked, even with no supplied steps.

Results include `valid`, `runtime`, SHA-256 of the exact source UTF-8 bytes in
`source_sha256`, `stage`, optional `diagnostic` (`message`, `line`; 0 when the
runtime has no source location), `checks`, `rendered_tree`, `reopened_tree`, and
`persisted_test_state`. Checks include the zero-based `step` for supplied actions.
`tree_only: true` explicitly means this is an interpreter-tree inspection, not a
pixel screenshot or a complete Swift compiler typecheck. Success covers the
supplied path; it does not prove all future interactions succeed.

Input is capped at 1 MiB; source, state and agent fixture strings at 256 KiB each;
state nesting at 64 levels; collections at 2,000 entries. Normal session execution
budgets and cooperative cancellation still apply. Output is capped at 512 KiB;
when trees exceed their shared 160 KiB allowance they are pruned and
`output_truncated` is true. Saved test state and diagnostics are retained.

Use the shipped executable for JSON-only stdout, with the same validator:

```sh
swift build --package-path apple/NanocodexApps --product native-app-journey
apple/NanocodexApps/.build/debug/native-app-journey --validate-json < request.json
python3 apple/NanocodexApps/Journeys/validate.py \
  --binary apple/NanocodexApps/.build/debug/native-app-journey \
  --output output/native-app-validation
```

Validation failures return `valid: false` in JSON; this CLI mode exits normally
when it produces a validation receipt. The runner retains requests, command
lines, stdout receipts and stderr for successful and rejected journeys.
