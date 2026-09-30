# Native Swift app UI journey

On macOS with an existing booted iPhone simulator, run from the repository root:

```sh
apple/Tests/NativeAppsUI/run.sh
```

This standalone simulator app links the production `NanocodexApps` package. It
loads separate Swift source files at runtime through `NativeAppSession` and
renders them through `NativeAppView`. Generated sources are bundle resources,
not app-specific code compiled into the renderer. The host stores JSON files in
the app's Documents directory. Only the external agent response is a fixed
fixture; parsing, evaluation, rendering, input, and persistence are real.

XCTest taps native buttons, types into native text fields, toggles a native
switch, observes list rows and totals, and terminates/relaunches the process to
verify saved state for six independent apps:

- Cigarette count, undo, and an agent coaching response.
- Calorie entry, computed total, and meal history.
- Form input, reminder toggle, and list insertion.
- Independently generated Smoke Log: dated records, undo, chart, and pack cost.
- Independently generated Meal Notes: validation, meal journal, remaining goal,
  and an editable external-agent estimate.
- Independently generated Pack Light: item insertion, packing, and progress.

The independent Swift sources come unchanged from `apple/NanocodexApps/Journeys`.
`NATIVE_APP_HOLDOUTS` can select an alternative directory containing
`cigarette-tracker.swift`, `calorie-tracker.swift`, and `packing-checklist.swift`.
Each test resets only its own apps before launch, then reopens without reset.
This keeps final file assertions independent of test execution order.

The runner uses `scripts/xcodebuild-guard.sh` and reuses one booted simulator.
`NATIVE_APP_SIMULATOR` can select an existing simulator explicitly.
For iteration after a full run, `NATIVE_APP_TEST=testIndependentGeneratedSources`
runs just that XCTest journey. Disk assertions still require all six apps' saved
state, so use the unfiltered command for a clean checkout or CI.
`NATIVE_APP_FIXTURES` can supply a directory with `cigarettes.swift`,
`calories.swift`, and `form.swift`; the UI journey expects the same public labels
and behavior as the included fixtures. Adapt the UI journey when a generated
app intentionally uses different controls or wording.

Each run writes an Xcode result bundle, UI screenshots, test log, and copied
state files under ignored `output/native-app-ui/`. State values for all six apps
and both agent request inputs are independently asserted after UI tests pass.
Failed runs also export screenshots and attachments. Named journey screenshots
are collected in each run's `*-attachments/screenshots/` directory.
The runner never deploys to a device or a service.
This journey does not test live cloud persistence or live model generation.
