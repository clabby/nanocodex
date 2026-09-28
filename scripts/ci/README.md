# CI job selection

`select-jobs.mjs` compares the complete PR diff against its merge base, or the
complete before/after range for a push. Deletions and both sides of renames count.
Rust paths are mapped to workspace packages with `cargo metadata --no-deps`, then
expanded to every workspace package that depends on them (normal, build or dev).
Jobs are selected by the packages they build:

| Family | Jobs | Selected by |
| --- | --- | --- |
| `rust` | fmt + Clippy on affected crates (fast lane) | any affected package |
| `rust_extra` | independent crate checks, docs | any affected package |
| `hands` | Linux/macOS shared Hand | `nanocodex2-bin` closure, `js/desktop-runtime`, CUA bridges |
| `windows` | Windows Hand and installer | `nanocodex-bin`/`nanocodex2-bin` closure, `windows/`, `install.ps1` |
| `vm` | static guest and Docker Hand | `nanocodex-vm` closure, CUA bridges |
| `voice` | native voice runtime | `nanocodex-voice-native` closure, `third_party/codex-voice` |
| `python` | Python wheels | `nanocodex-python` closure, `py/`, `examples/python` |
| `wasm_rust` | WASM Clippy; also selects JS consumers | `nanocodex-wasm` closure |
| `wasm`, `bindings`, `apps`, `preview` | WASM artifact and JS consumers | JS package paths |
| `policy` | cargo-deny, boundaries, typos, Cloudflare script policy | any non-binary path |
| `codeql` | Actions analysis | `.github/` |

Root `Cargo.toml`, `Cargo.lock`, toolchain and `.cargo/` files, JS lockfiles and
workspace manifests, `ci.yml`, `js-preview.yml`, `.github/actions/`, `scripts/ci/`,
unknown paths, an unavailable diff or Cargo graph, and `merge_group`, scheduled and
manual runs select everything (`packages=*`). Keep the allowlist conservative when
adding new cross-language inputs; files a crate reads outside its own directory
belong in `crossPackageInputs`.

Draft pull requests get the fast lane only: fmt/Clippy on affected crates, WASM
Clippy, policy and JS typecheck/build. Marking the PR ready for review reruns CI
with the heavy lane (native matrices, Python, docs/contracts, preview, CodeQL).
Superseded PR pushes cancel their previous run; master and merge-queue runs are
not cancelled once started. The workflow accepts `merge_group`, so a merge queue
can be enabled in repository settings.

`pnpm check:fast` runs the same fmt + Clippy command as the fast-lane job for the
crates changed since the merge base with `origin/master` (including uncommitted
and untracked files). Run it before pushing.

## Paused tests

Automatic CI tests are paused. Every paused step and the workspace `test` job is
gated on the `tests` selection output, which is `true` only when the workflow
env `NANOCODEX_CI_TESTS` is `on`. Re-enabling is that one line in `ci.yml`.
Rust test steps use `cargo nextest run --profile ci` (`.config/nextest.toml`):
host IPC tests are serialized and retried, and retried passes are reported as
flaky. The `vm-guest` Docker Hand tests also exercise `nanocodex2`; add `hands` to
that job's condition when re-enabling them.

## Final gate

`ci success` runs `select-jobs.mjs verify` with `toJSON(needs)`. Every selected
job must succeed and every other job must be skipped. Missing selection outputs
or a job without a mapping in `select-jobs.mjs` fail the gate, so update the
`gate` table when adding a job. The upstream-only package preview is never
selected in forks.

Run `node --test scripts/ci/select-jobs.test.mjs` and
`actionlint .github/workflows/ci.yml` after changing selection. The test drives
the real CLI against Git histories and a Cargo workspace fixture.

For measured run and step timings:

```
node scripts/ci/timings.mjs OWNER/REPO LIMIT OUTPUT_PREFIX [RUN_ID...]
```

Pre-execution elapsed includes dependencies and workflow gates as well as runner
queueing. Compare equivalent workflows; production deploy and the full native
CI suite have different scopes.

## Rust compilation

Every Rust job uses `.github/actions/rust-compiler-cache`: a Cargo registry
cache plus pinned sccache on GitHub's cache backend. Per-job target archives
(0.8-1.4 GB each) exceeded the 10 GB repository cache budget and evicted one
another, so the Clippy lane usually started cold. sccache entries are shared by
every job and survive lockfile changes; proc-macros, build scripts and links still
run. The Windows job, which is the longest, also keeps its target archive.

The fast lane runs fmt, library Clippy on the affected packages, and CLI/benchmark
Clippy in one job so both invocations share dependency artifacts. The independent
crate checks remain separate Cargo invocations: merging their package flags would
unify features and weaken that check.

JavaScript jobs restore Turborepo's local cache from the Actions cache
(`.github/actions/turbo-cache`); only master writes it.

The Windows Hand lifecycle and installer share one Windows 2025 runner and one
CLI build. The real installer build validates its definition.

Preview publishing uses the supplied artifact whenever its workflow input is
present, including a manually dispatched parent CI. A standalone preview still
builds its own artifact. Preview concurrency separates parent workflows and
manual/full runs, so an unrelated push cannot cancel a required preview.

## Cache storage and writers

PR compiler caches are read-only. Only master push, manual, and scheduled runs
write sccache entries; cache misses still compile normally. This avoids concurrent
PR-local uploads competing with reusable master entries for the cache API quota.

Docker intermediate layers use the public `ghcr.io/<repository>-hand` package,
with separate `buildcache-*` tags per consumer and architecture. They no longer
consume the Actions cache capacity needed by Cargo and other dependency caches.
PRs import anonymously; only trusted master runs log in and export. A missing
cache or a failed cache login/export leaves normal builds available. These tags
are cache metadata, independent of runnable image tags and deployment receipts.

Master CI seeds its Hand caches on push, schedule, or manual dispatch. Toolkit
caches seed on master dispatch; Cloudflare seeds when a trusted deployment needs
an image build. Successful cache availability checks emit a Docker registry cache
notice. Compare a later run after seeding before attributing a speedup to reuse.
Old Actions cache entries can expire normally; no cache deletion is required.

The policy job runs the Wrangler Docker, image and release-plan script tests.

## Cloudflare preview latency

Worker builds and uploads determine `Cloudflare preview success`. Ready dialog
and playground assets upload immediately after artifact restoration, before
unrelated Worker validation, evaluator preparation, or Astra dependency setup.
Worker build or validation failures still fail this gate.

Preview container compilation is skipped on PRs and ordinary preview dispatches.
Production already publishes changed phone and sandbox inputs independently of
Worker deployment. To test Docker changes before merging, dispatch the Cloudflare
workflow with target `preview` and `validate_images: true`. The separate
`Cloudflare image validation` check then requires image selection and both full
image builds; it never delays the Worker readiness gate. Image failures remain
visible instead of being converted into successful Worker results.

Image validation remains unprivileged with no registry writes. Its sandbox build
retains Dockerfile checks; preview Worker validation uses
`--containers-rollout none`. Production release compilation, image verification,
publication and immutable receipts keep their existing behavior.

Production builds applications in deployment order. Infrastructure and managed
Workers upload before unrelated consumer and account UI builds, with successful
health/receipt barriers and account deployed last. Completed shared build targets
are reused between phases. Superseded pushes stop before starting another phase.
The small orchestration tests run in the main CI policy job even while
behavioral test suites remain paused.

Preview image validation uses BuildKit's `cacheonly` output. It still evaluates
the complete Dockerfile, including its checks, but does not export and load an
unused image into Docker Engine. Production publication retains `--load` for
its runtime verification, registry push, and immutable digest receipt.

The native Linux, macOS, and Windows jobs gate their Node/pnpm setup on the
same `tests` switch as their JavaScript lifecycle suites. Their active Cargo
builds and Windows installer do not consume the pnpm workspace.
