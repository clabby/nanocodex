# Deployment and CI execution paths

Cloudflare production has two independent managed image publishers (phone and
sandbox), followed by the ordered Worker deployment. Each publisher restores a
small receipt keyed by the committed inputs used by its Dockerfile, the account,
platform, helper version, and `MANAGED_IMAGE_CACHE_EPOCH`. A hit skips dependency
installation, Docker build, image smoke tests, and registry push; these already
ran when that exact image receipt was produced. A miss builds and verifies the
image, pushes it through Wrangler, and records its actual registry SHA-256 digest.
Before mutating production, push deployments check for a newer Cloudflare push
under the production concurrency lock and skip superseded runs. Explicit manual
deployments remain possible. The deployment accepts only receipts matching the current source inputs and
account. It has no fallback to a mutable tag or a Dockerfile build.

These input keys are cache keys, not image digests. Docker base tags and package
repositories may change independently of source. To refresh upstream image
contents, or recover from a deleted registry image, increment the repository
variable `MANAGED_IMAGE_CACHE_EPOCH` (default `1`) and dispatch Cloudflare with
`target=production`. An Actions cache eviction is harmless: the image is rebuilt.
Keep the resulting registry digests while their receipts remain cached. Config,
resource, and binding changes are still applied with the reused image; Wrangler
compares the existing application configuration and skips an identical rollout.

Production completion includes a bounded public account Worker health check.
The separate **Cloudflare live validation** workflow currently runs only by
manual dispatch on master with `CLOUDFLARE_DEPLOY_ENABLED=true`; its automatic
post-deployment trigger is paused. The `all` suite runs cron, large-input,
durability, and goal journeys; `goals` selects only goals. One live validation
workflow runs at a time, with newer pending runs coalesced. These checks exercise
live production, which can advance during a long test; they do not certify a
frozen preview environment.

CI publishes one WASM artifact containing both `pkg-node` and `pkg-web`, including
package markers, declarations, and the attestation. JavaScript consumer checks
and immutable package previews reuse that artifact. Preview publication is also
manually dispatchable with a standalone build. The success gate requires each
applicable build/check job; behavioral test steps are currently paused in the
[CI workflow](../../.github/workflows/ci.yml).

Apple CI (iPhone, iPad, native Mac and Swift app workflows) is removed. Build and
test Apple targets locally through `scripts/xcodebuild-guard.sh`.

CI runs on pull requests, the merge queue, a daily schedule and manual dispatch,
not on pushes to master. Deployment never waits on CI. The production WASM build
starts in the background as soon as Rust is installed, and its sccache server is
started outside Turbo so the GitHub Actions cache backend stays enabled.

## Measurement

Report runner wait, actual job execution, deployment completion, and endurance
completion separately. Compare the first cold run and a subsequent run with
unchanged image inputs; a cold receipt miss intentionally still publishes images.
Record cache hit outputs, registry push duration, and any failures before claiming
a speedup. Keep per-run timing reports as CI artifacts or in ignored `output/`.

To capture recent runs without changing them:

```sh
node scripts/ci/timings.mjs gakonst/nanocodex 25 output/ci-timings
# Or compare specific runs (the limit is ignored when IDs are supplied):
node scripts/ci/timings.mjs gakonst/nanocodex 1 output/ci-comparison RUN_ID_1 RUN_ID_2
```

The tool uses the authenticated `gh` CLI and writes JSON step details plus a
Markdown summary. Pre-execution elapsed includes dependency and concurrency
waits as well as runner scheduling; it is not a pure runner-queue statistic.
It never treats a queued job's placeholder `started_at` as runner execution.
