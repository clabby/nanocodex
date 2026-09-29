# NanocodexApps

A SwiftSyntax parser, bounded interpreter, and native SwiftUI renderer for generated Swift apps. Source stays Swift from authoring through execution. The host supplies persisted JSON and the asynchronous agent service. See [AUTHORING.md](AUTHORING.md) for the supported source contract and limits.

The package supports iOS 17 and macOS 14. Build with Swift 6.2 or later, matching the pinned SwiftSyntax 602 dependency.

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

Session and view operations run on the main actor. `NativeAppSession.validate(source:)` validates source without executing it. `AppValue` encodes ordinary JSON strings, numbers, booleans, nulls, arrays and objects. `@Persisted` keys survive session restarts; `@State` values remain local to the session. Host failures and runtime limits appear in `session.diagnostic` and in the native view. Failed actions restore the preceding state.

## Run a public journey

From the repository root on macOS:

```sh
swift run --package-path apple/NanocodexApps native-app-journey --help
swift run --package-path apple/NanocodexApps native-app-journey --self-test
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

`--agent-response` configures the local host's asynchronous external service stub; omitting it causes an explicit error when source calls `Agent.run`. This CLI does not contact a production agent. `--screenshot` uses `NSHostingView<NativeAppView>` and AppKit to save a 900 × 1100 point PNG of actual native controls after all operations. Screenshot rendering requires a macOS graphical session; pixel dimensions follow the display scale. Captures use a light appearance, opaque window background, and active blue controls for consistent local and CI evidence. Without that flag, journeys assert the public rendered tree without requiring a visible window. Errors exit nonzero.

Run the independently authored tracker holdouts through the executable:

```sh
swift build --package-path apple/NanocodexApps --product native-app-journey
python3 apple/NanocodexApps/Journeys/run.py \
  --binary "$(swift build --package-path apple/NanocodexApps --show-bin-path)/native-app-journey" \
  --output output/native-app-holdouts/verified
```

The runner retains source inputs, real JSON state, CLI commands, and control-tree traces under the selected output directory.
