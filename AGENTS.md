# Nanocodex development

- Define observable behavior and failure cases before implementation. Validate
  changes with black-box, end-to-end journeys that a real user could perform:
  invoke the shipped CLI, call the public API over its actual transport, or use
  both when both surfaces matter. Run the real executable/runtime and assert on
  user-visible results, including representative errors, authorization, and
  recovery paths. Use synthetic accounts/data and safe test environments; stub
  only unavoidable external dependencies, not the behavior under test.
- Skip low-level unit tests as the default for both new coverage and routine
  validation. Do not add helper-by-helper or mock-heavy tests to stand in for a
  user journey. Prefer a small set of representative E2E scenarios over a large
  matrix of incidental configurations. If a critical failure truly cannot be
  observed at a public boundary, document that gap and use the narrowest
  realistic integration check rather than silently substituting unit coverage.
- Finish each E2E run with reproducible evidence: the command, inputs, expected
  and observed outcomes, and an inspectable trace, transcript, log, screenshot,
  or recording where relevant. A passing test name alone is not evidence.
- Continuously look for ways to improve the developer experience in CI. Inspect
  the relevant jobs' actual results, duration, failures, and artifacts; favor
  fast, reliable user-journey feedback, actionable failure output, and easy
  reproduction locally. Remove redundant work and flaky setup, but do not hide
  failures, skip required checks, or trade away meaningful E2E coverage merely
  to make CI green. When changing CI, verify the resulting workflow run.
- When a journey or protocol check covers the same failure, remove redundant
  lower-level cases, unused fixtures, test-only APIs, and obsolete runner
  references. Prune mock setup that no surviving scenario uses. Use compiler,
  lint, and package checks for static contracts; do not test source text,
  private layouts, method presence, fixed prompt/UI copy, or a mock's own
  behavior as a proxy for runtime behavior.

- Keep documentation focused on current APIs, architecture, setup, and operations.
  Remove superseded designs, implementation plans, checklists, and review notes
  when the work lands; Git retains their history. Update links and consumers
  when removing documents or support files.
- Publish per-run screenshots, videos, logs, traces, and benchmark results as CI
  artifacts or keep them in ignored `output/`. Do not commit generated evidence;
  retain only intentional fixtures consumed by tests or current documentation.
- Keep only the static assets and fixture files their consumers need. Check
  dynamic filename construction and build manifests before pruning imported
  asset packs; preserve attribution and canonical source artwork.

- `macos/` owns the desktop app and native tiled workspace; `js/desktop-runtime`
  owns its runtime. `apple/NanocodexInbox` targets iPhone and iPad.
- `js/nanocodex` and `js/nanocodex-react` are public contracts. Cover changes
  with relevant contract, type, package, and runtime checks.
- `js/nanocodex-vite` owns the Vite plugin, WASM build, OAuth relay, and
  Cloudflare Vite integration.
- Apps and Workers deploy independently. Shared behavior belongs in a package,
  consumed through its public API.
- Use root `pnpm` scripts and existing Turbo/Portless/Vite/Wrangler tooling.
  Deploy dependencies first and `account` last. Component deploy scripts build
  their dependencies from a clean checkout. See [README.md](README.md) for setup.
- Use synthetic identities and project data in fixtures and examples. Keep real
  account IDs, private project inventories, and one-off personal migration plans
  outside tracked source; pass operational data through private runtime inputs.

- On a shared macOS Hand, invoke Xcode through `scripts/xcodebuild-guard.sh`
  instead of raw `xcodebuild` for `apple/` and `macos/` work. The per-user OS
  lock queues builds across agent sessions until the build actually exits; the
  default `-jobs 3` leaves CPU for interactive use, and UI tests default to one
  nonparallel Simulator destination. Explicit caller flags override those
  defaults. Do not boot duplicate simulators for concurrent UI tests; shut down
  only the simulators used by your run when finished.

## Shared-checkout hygiene and delivery

- Record the starting branch, HEAD, and dirty paths; fetch the actual target
  branch before comparing or integrating. A dirty checkout or absent remote
  branch name does not prove work is unpublished. Compare against the published
  tree and commit ancestry, accounting for renamed paths and cherry-picks.
- Use an isolated, named worktree from the current integration base when the
  shared checkout contains other work. Keep scratch worktrees outside tracked
  source or in an ignored directory. Never stage all files, borrow another
  agent's changes, or overwrite a branch/worktree owned by an active task.
- When publication is requested, finish the commit and nonforced push, and
  verify the remote SHA. Verify merge, CI, and deployment receipts separately;
  a local commit or accepted push is not proof of any of those outcomes.
- After publishing from a separate worktree, reconcile the original checkout.
  Remove task-owned tracked changes and untracked copies only after proving
  they are already published. Fast-forward the primary checkout when safe;
  preserve unrelated or unpublished work and report its exact remaining paths.
  Do not leave released copies looking like unfinished work for the user.
- Before cleanup, inspect fresh status and preserve recoverable before-images.
  Recheck that files have not changed since inspection. Use explicit paths;
  never use blanket hard resets, force-clean worktrees, or discard unknown
  changes. Do not bury unrelated work in an unexplained stash or delete local
  branches merely because their names do not exist on the server.
- Remove completed temporary worktrees only after checking both their dirty
  files and unpublished commits; otherwise retain them with an explicit owner
  and reason. Keep operational backups and evidence in ignored output, not in
  tracked source. Ignore local worktree containers rather than deleting their
  contents just to silence an untracked-directory entry.
- Finish with verified local and remote HEADs plus fresh tracked/untracked
  status. Distinguish already-published duplicates, actual unpublished work,
  and generated/local-only files. Never claim every dirty file is on master
  without checking; report blockers instead of making the user repeat cleanup.
