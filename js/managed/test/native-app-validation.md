# Native app validation journey

Run from the repository root on macOS with Swift 6.2 or later and the workspace's
JavaScript dependencies installed:

```sh
swift build -j 3 --package-path apple/NanocodexApps --product native-app-journey
pnpm --dir js/managed test:apps:native
```

The test defaults to `apple/NanocodexApps/.build/debug/native-app-journey`.
Use `NATIVE_APP_BINARY=/absolute/path/to/native-app-journey` for an existing build,
including builds using a custom Swift scratch path. A missing binary fails the
test; it does not skip native validation or substitute a compiler fixture.

The Node harness starts workerd with real D1 and the production `appTools` and
`routeAppsRequest` handlers. Its local HTTP validator invokes the Swift CLI's
`--validate-json` entrypoint, which calls the same parser and interpreter as the
native app. A second journey publishes a fixture Hand over WebSocket into the
real `AccountHostedTools` Durable Object, then exercises `nativeAppValidator`,
account discovery, `machineTool("validate_app")`, dispatch, and receipt handling.
That publisher also executes the actual Swift binary for every invocation.
Authentication is a synthetic account fixture; this does not exercise deployment
or the installed iPhone's WebSocket publisher.

Coverage includes rejected record initializers before app creation, line
diagnostics, log/undo/reopen, isolated test state, source hashes, failed edits
preserving the complete database row, missing/offline validators, and HTTP
storage revisions, concurrent data writes, account isolation, restore, deletion,
authorization, and invalid input. Successful saves return native validation
receipts. The result proves the supplied interpreter journey; it does not claim
full Swift compiler typechecking or rendered pixel/screenshot coverage.

Each run writes source, input JSON, exact subprocess arguments, stdout/stderr,
HTTP/tool results, WebSocket frames, and final database rows into a timestamped
directory under `output/native-app-validation/`. `NATIVE_APP_VALIDATION_OUTPUT`
overrides that parent directory. The final PASS line prints its path. Evidence
is ignored output, not committed fixtures.

`pnpm --dir js/managed test:apps` remains a small cross-platform test with no
native Hand. It checks authorization, invalid API input, and unavailable-validator
fail-closed behavior through the production HTTP route and account proxy. The
successful storage/recovery journeys run in `test:apps:native` so no test needs to
invent a passing Swift interpreter result. No Swift compiler is required by the
ordinary `test:apps` command.
