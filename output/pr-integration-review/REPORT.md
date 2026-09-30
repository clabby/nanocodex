# PR697 integration review — full rollout BLOCKED

Original PR head: `ecb0b26024a0189f1c8e6d65b31018de1e24543a`.
Pinned integration base: `168ac402ecdcffafe3748111d8e6834b8174f689`.
Local merge: `dfa735ed8` (clean). Bounded implementation/tested code HEAD: `efb7aa4cd295a7af8c5a6b6f6d079051112be8a9`.
Branch: `audit/pr697-20260930`. No remote Git write, deployment, live mailbox mutation, credentials/Vault access or invented approval.

## Actual gap audit

The PR body and `docs/DECISION_INBOX.md` HOLD are substantive, not stale wording. `prepareDecisionProposal` blocks every model-generated capture with `complete_capture_proposal_unverified`; the job layer repeats that fence. Source excerpts/citations and model “ready” assertions cannot independently verify whole-request completion. The current public-query allowlist is intentionally narrow and does not enable arbitrary research. Account-local drafts are not Gmail Drafts. Background watcher health and approved real-send acceptance are unproven on this branch.

## Concrete bounded fix

Added `todo-text-proposal.ts`: one complete deterministic operation, exact `Format this as bullet points:` header followed by literal supplied lines. Whole capture <=4096 UTF-8 bytes, 1–100 nonempty trimmed lines, no ambiguous control characters. Every line is preserved verbatim/in order; a separate verifier checks prefixes, line count and all source-line content, rejecting omission/addition/reordering. The payload is data, not instructions. No model, CRM, public-query, mailbox draft or external action is invoked. The shown scope explicitly says factual content is not checked.

Nonempty owner Change instructions invalidate this contract. All model-generated rewriting/summarizing/translation, mixed external requests and arbitrary research remain gated unchanged. Target version/generation/lease checks and Park/done protections remain in force. Exact draft/source/recipient fences and durable provider-unknown no-retry behavior are unchanged. This fixes a real deterministic subset, **not general capture completion or full product readiness**.

## Evidence on the pinned code

- Actual shipped account proxy/auth/router -> Worker `UserAccount` SQLite/alarm -> fixture inference/provider HTTP loop: **12 groups passed**, `--safety-gated-captures`. Deterministic capture readiness/reopen/Park/reopen used zero model/provider calls. General capture model-ready claims remain blocked. Exact draft edits, stale source/recipient/thread/generation fencing, accepted fixture send, accepted-then-504 unknown and real Worker restart persistence/no retry all pass. **2 fixture-only sends, 0 live sends**; 25 fixture model calls across Worker epochs for other jobs.
- The unchanged default full-ready harness intentionally exits **1** with `capture readiness required; got blocked/complete_capture_proposal_unverified (product acceptance HOLD)`. It performs zero fixture/live sends before failing. The original completion requirement has not been weakened to turn a rollout HOLD green.
- Workerd-focused account/Inbox/preparation/calendar/source-health/Gmail suites: **146 passed** (including 25 deterministic contract cases and two new durable lifecycle cases). One initial 5-second timeout on 200 SQLite fixture insertions under concurrent builds; rerun with CLI `--testTimeout 30000` passed all tests, without guard/product changes.
- Read-only research adversarial tests: **53 passed**.
- Native InboxCore: **295 executed, 6 explicit live-opt-in skips, 0 failures**. No UI/Simulator/phone test claimed here; root owns combined Simulator acceptance.
- Whole managed source/test TypeScript: **exit 0**. `git diff --check`: clean.
- Egress whole suite with package-pinned mppx 0.11.0 and lockfile viem 2.55.19: **295 Worker tests + 6 Node payment tests passed**; whole egress TypeScript passed. Missing npm-package sourcemaps emit nonfatal warnings, not test failures.

HTTP bundle SHA-256: `ce3ab485b0c6d90d2914da12ee5c9b37511cebb8dda6ed78e62250b4555403da`. Bundle start/end/test HEAD all match the tested code HEAD above. Warm persisted loopback snapshot n=8, descriptive p50=6.60ms/p95=43.52ms: not model-preparation latency, native navigation/device timing or production SLA.

Evidence: `output/pr-integration-review/{http-closed-loop.json,http-closed-loop.log,full-ready-expected-hold.json,worker-tests-rerun.log,research-tests.log,native-tests.log,typecheck-final.log,egress-typecheck-exact.log,egress-tests-exact.log}`. Fixtures use synthetic owners, example.test mail and public guidance snippets; no private correspondence/credential material is in this report.

## Remaining specific release blockers

1. A practical independent whole-request completion contract for supported non-deterministic captures; arbitrary research/semantic transforms remain unverified. Do not treat unknown runtime/model behavior as proven completion.
2. Actual Gmail Drafts synchronization and its provider-version/concurrent-editor approval contract, not merely account-local drafts. Real Gmail labels/filter hygiene remains separate reversible, approval-required work; no rule changes were made.
3. Explicit approval of one exact designated real-provider test message and branch-deployed read-back/acceptance/delivery evidence. Fixture acceptance is not delivery proof or live authorization.
4. Branch-deployed logged-in background source/watch health and actual mailbox coverage acceptance; passing source-health fixtures or connected-account state is not proof of working collection.
5. Combined iOS build/Simulator and deployed/physical-phone/cache-first acceptance owned by root; this review did not install, ship or update a phone.

## Merge recommendation

**Do not merge/release PR697 as the completed Decision Inbox feature.** The bounded deterministic fix is locally committed and testable; root may decide to integrate separately gated foundations or retain this draft. Its integration hook relies on the existing PR697 preparation infrastructure, so the entire commit is not an independent main-branch cherry-pick. The pure helper/test can be broken out separately if useful. No feature/readiness guard was relaxed merely to obtain green tests.

Dependency caveat: existing frozen offline workspace install fails overrides/lockfile configuration mismatch. Own-worktree workspace links plus existing external artifacts, locally generated tools/connect-protocol declarations and just-bash bundle were used. For egress, package-pinned mppx 0.11.0 is installed in an isolated ignored output directory with lockfile viem 2.55.19 deduplicated; stale mppx 0.9.1 reuse and duplicate-viem attempts were discarded, not counted as final evidence. No shared source/lockfile edits.
