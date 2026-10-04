# API release path

The API production job starts directly on a master push, without `needs` on image
planning, Docker publication, native/phone builds or CI tests. It selects changed
Workers inside its serialized deployment job, then installs/builds only their
packages. There is no Docker builder or image recovery build in this path.

Only managed, account and playground require the Rust SDK WASM build. The private media
Worker bundles its own checked-in FFmpeg WASM; it, egress, X, email, Connect API,
Connect dialog, Astra and Chief of Staff do not schedule a Rust SDK build. Explicit build tiers avoid
Turbo's general SDK-to-WASM build edge while preserving compiled dependency order.
When adding a runtime import or generated asset, update `workerSpecs`/build targets
and exercise a clean build with the generated WASM directories absent where the
Worker is declared JS-only. Source keys include runtime/config/assets and relevant
build scripts, not development stress tools or native-image preparation scripts.

The shared `.github/actions/wasm-outputs` action verifies exact-input browser/Node
bindings and retained raw WASM before setting up Rust. Actions cache is the fast
lookup; trusted master builds also retain exact-key artifacts for 90 days. Cache
eviction restores that artifact before considering compilation. Publication
deduplicates recent artifacts and refreshes those nearing expiry; PR/fork outputs
cannot seed production reuse. Verified hits skip Cargo,
wasm-bindgen and wasm-opt and reattest for the checkout. Misses rebuild with Rust
1.97. Both the outer cache key and inner binding stamp cover generator policy.
Provably non-WASM Cargo target tables and standalone tests/benches are excluded;
unknown targets, optional dependencies and build-script inputs remain conservative.
Python 3.11+ is required for deterministic release planning. Standalone WASM builds
can still compile without cache reuse if input discovery is unavailable; releases
fail early at planning rather than generating an unstable release identity.

Managed releases use already-published immutable phone/sandbox images. Selection
prefers a successful receipt for the current image inputs, falling back to the
latest successful published image while a new image builds independently. The
selected digests are pinned for the job and included in the Worker identity.
New Rust/image source alone never makes the API wait for publication. If no image
has ever been published, bootstrap publication is an explicit prerequisite; CI
never silently starts a native build inside an API release.

Image preflight and publishers run independently. Same-input publishers coalesce
and recheck durable GitHub Deployment receipts after acquiring their slot. Once
publication and the API release finish, a separate serialized rollout updates only
the relevant Workers. Its managed images must match current source inputs. If a
newer master supersedes that rollout, published digest changes are detected by the
next API release. Image failure cannot block the API production job.

Publication rejects dirty relevant source because image keys hash committed HEAD.
`MANAGED_IMAGE_CACHE_EPOCH` changes image identity, pulls bases and invalidates each
Docker stage's upstream layers; ordinary source changes retain layer reuse. Bump it
to refresh upstream content or recover deliberately deleted registry images. Audit
new Docker COPY/build-script reads and external generated inputs in the input helper.
Preview container decisions compare these same committed keys, so SDK JavaScript
alone cannot trigger native image builds.

The account relay image also publishes independently, once for all regions, from
its audited Docker inputs. API releases consume a published receipt; before the
first such receipt, they preserve each existing Cloudflare application's image.
Account image selection is pinned during planning. Vite's config is rewritten
beside its output, preserving relative paths. Account releases explicitly stamp
the revision, and health must report it before the release is certified.

Worker release identity combines source/dependency/config keys with account scope.
The ledger records intent before mutation. Success requires command completion,
phase health, and a live Cloudflare deployment serving one 100%-traffic version
with `nc-ci-<fingerprint>`. The GitHub success status stores the live deployment and
version IDs. Reuse requires those IDs and tag still match Cloudflare: manual pnpm /
Wrangler deploys, old-ref rollbacks, split traffic, interruptions and unknown state
cannot masquerade as a current successful release. A source-identical manual deploy
may therefore cause one deliberate reconciliation deployment on the next CI run.

Managed's upload command also owns its private-account CRM D1 database. It
resolves or creates `nanocodex-crm-production`, pins the returned UUID into the
same generated config used by migration and upload, and applies pending SQL
migrations before deployment. Each mutation rechecks current master; a failed
migration stops the phase and dependent Workers. The production token requires
D1 edit permission. Schema migration files and the preparation helper participate
in managed's release fingerprint. See [managed database operations](../../js/managed/README.md#private-account-crm-database).

Managed preview validation uses `pnpm run preview` in `js/managed`: an isolated
local CRM migration followed by a Worker dry-run. It replaces production D1 IDs,
removes named environments and cloud credentials, and creates no cloud database.

Selected deployments preserve dependency phases: egress/X, private media, managed,
consumers, then account. A scoped `RELEASE_ONLY=managed` also selects and redeploys
media before managed; unchanged media is otherwise safely reused through the live
Worker deployment ledger. Independent members run concurrently. Every mutation rechecks current
master; failed phases prevent later ones. Astra secrets are applied additively in
its tagged deploy using a temporary private secrets file, then removed locally.
Each phase checks health before success receipts. The job summary records per-Worker
durations. Explicit production dispatch forces every component, including rollback.
The first run after key/ledger changes is cold; warm-release time must be measured
separately. Preview builds remain unprivileged and separate from credentialed upload.

Automatic CI tests are temporarily paused. Builds, selected lint/type checks,
artifact/receipt checks, current-master guards and deployed health remain active.
`CI_TESTS_ENABLED=false` suppresses image runtime smoke suites; manual/local image
builds default to running them. Live validation is manual-only. Re-enable the test
conditions and image test flag together when the pause ends.

## Native PR Worker Previews

`node scripts/cloudflare/preview-workers.mjs --name pr-123` deploys native
Cloudflare Worker Previews for managed, Connect API/dialog/playground, then account.
Run after restoring/building the same-revision Worker artifacts. It uses root
Wrangler (minimum 4.135), existing production container image references, and
server-side Previews Base configuration. It does not deploy production code,
create databases/buckets, apply migrations, or export production secrets.

Set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `GITHUB_SHA` (or
`PREVIEW_REVISION`, a full commit SHA). `PREVIEW_NAME` is an alternative to
`--name`. `--check-only` performs metadata preflight without provisioning or
uploading. `--component assets` selects only dialog/playground; individual names
are also accepted. Account and managed are always deployed together because their
private bridge key rotates together. Manual workflow dispatch with `preview_component=assets` publishes the Connect
asset Previews independently. PR checks require the full application preflight.

All selected Workers must pass preflight before code uploads. Every current
production secret **name** must exist in that Worker's Preview Base. Values are
never read from production or written to the manifest. Provision secrets privately
with `wrangler preview base-config secret put NAME --worker-name WORKER`, or supply
the optional encrypted CI secret `NANOCODEX_PREVIEW_BASE_SECRETS_JSON`: a JSON object
keyed by Worker name whose values are secret-name/string-value maps. The script
validates names against production metadata and PATCHes only supplied Base entries.
It never prints those values, puts them in command arguments/files, or passes the
seed JSON to Wrangler. Check-only never applies this seed, but validates supplied names and counts them toward new-Preview readiness. Base updates affect new
Previews only: an existing Preview missing a secret must be provisioned separately
with `wrangler preview secret put NAME --name pr-123 --worker-name WORKER`.

Production storage is not implicitly reused. For every D1, R2, KV, and AI Search
binding, preprovision a separate resource in Preview Base. D1 schemas must already
be migrated. Preflight rejects matching production resource identifiers and checks
existing Preview resources still match Base. Additional storage kinds require an
explicit script policy. Enable workers.dev Preview URLs on the parent Workers
before uploading; the script will not deploy production merely to enable URLs.
See [Cloudflare Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/)
and [resource isolation](https://developers.cloudflare.com/workers/previews/resources/).

The account/managed HTTP bridge receives a fresh random shared secret over the
Wrangler child's stdin (`--secrets-file /dev/stdin`, Linux CI), with both expected
origins configured. No bridge secret is saved in temporary configs or artifacts.
The account Preview omits its three direct production managed-DO fast paths.
Other service bindings and foreign Durable Objects still target production; the
manifest records these boundaries. Local Durable Objects and containers are
isolated by Cloudflare, while account identity/subscriptions/connectors are not
copied into those namespaces. A successful upload therefore does not claim a
fully isolated backend or a completed authenticated E2E journey.

Temporary Wrangler configs are adjacent to their original configs to preserve
relative bundle/asset paths, and removed in `finally`. Wrangler stdout/stderr is
withheld because binding output can include values. Safe deployment receipts,
revision, URLs, image references, preflight names, and production boundaries are
written to `output/cloudflare-previews/pr-123/manifest.json` and the GitHub step
summary. A later failed component leaves completed receipts in that manifest;
unknown uploads are not retried automatically. Repeated uploads rotate the bridge
key and can briefly reject requests between the managed and account deployments.

Workflow entry points are `preview-workers.mjs deploy --name pr-N`,
`preview-workers.mjs check --name pr-N`, and `preview-workers.mjs delete --name pr-N`.
The earlier flag-only deploy and `--check-only` forms remain accepted. Cleanup
removes only the selected named Previews and verifies absence, preserving parent
Workers and Base configuration; deletion removes each Preview's isolated DO state.
`base-secrets-missing.json` is emitted alongside the manifest when preflight
completes, including on missing-secret failure. Successful account deployment
sets the `url` and `preview-url` GitHub outputs as well as `preview-manifest`.

After each upload, read-only HTTP probes retry for at most 30 seconds per Worker.
Account and asset roots must return HTTP 200 with HTML content type; account
`/v1/me` must reject an unauthenticated request with 401/403, and direct managed
root access must return 403. Bridge 503 responses fail readiness. The manifest
retains probe statuses alongside the deployment receipt, including failures.
Connect API remains receipt-only. These probes do not establish authenticated E2E.
