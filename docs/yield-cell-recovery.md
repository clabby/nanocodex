# Durable Code Mode observation reconciliation

A retained yielded exec receipt can survive replacement of the runtime that owned
its live cell. Previously the next wait only reported a missing cell. This change
makes that wait reconcile durable evidence without evaluating guest source,
dispatching tools, or reconstructing promises.

## Protocol and production wiring

The managed effect journal now provides an optional observation journal. The
runtime resolves the canonical operation/model identity once, registers the
public cell ID before guest execution, and stores each observation before
consuming its in-memory output. Registration and recording use the existing
durable owner generation fence and storage sync acknowledgement.

ManagedAgent constructs the journal in js/managed/src/index.ts and passes it as
codeEffectJournal to agent creation. The existing Node and Claude hosts pass the
same object as effectJournal to createCodeRuntime. No separate feature switch or
production-only alternate implementation was added.

Recovery authenticates through the caller's session and original cell mapping.
It never executes guest source, admits effects, cancels providers, or mutates the
journal. Completed original effect receipts remain historical evidence; pending
intent stays outcome unknown. Missing legacy mappings, evicted observations,
corrupt chunks/checksums and stale ownership fail closed.

A terminal observation proves the recorded script result. Its output and nested
receipts are rendered as historical text; nested_calls and notifications are
always empty. This applies to repeated waits with the same call ID and new wait
IDs. Exact replay of an acknowledged tool call remains the outer durable
CompletedToolCall ledger's responsibility. The observation ledger is deliberately
not a second event replay mechanism.

Unknown nonterminal recovery returns success=false and no cell field, so a past
running observation is never presented as a live executable cell. A terminal
recovery retains its recorded success and cell.running=false. Terminate on a
missing cell performs the same evidence read and does not imply termination.

## Retention and compatibility

Only the latest observation per cell is retained. Full envelopes are limited to
8 MiB; larger live results still succeed but retain a bounded recovery summary.
The newest retained envelopes are capped at 128 records and 32 MiB aggregate,
with older payloads removed transactionally. Small summaries add bounded metadata
over that payload limit. Original effect receipts and identity tombstones remain
in their existing journals; this is not global garbage collection of all managed
storage. Eviction sacrifices observation availability, never effect identity.

Wire fields are unchanged: output, success, optional cell, nested_calls, and
notifications. The Rust CodeModeExecution deny_unknown_fields struct accepts
these existing fields; no new machine outcome field was introduced. Claude's
production host consumes the result and exposes an empty nested event list.
Outcome-unknown details continue to be carried in textual evidence.

## Validation (2026-10-08)

- 10 tests passed in code-observation-recovery-node.test.mjs using native Node
  22.23.3 SQLite on disk and actual database close/reopen. Tests include replayed
  yield, completed late receipts, pending external intent, lost terminal ACK,
  same/new observer IDs, foreign sessions, stale owners, corrupt receipt,
  missing legacy ID, cancellation before execution, oversized output, wait
  budget, count/byte retention, and production Claude consumption.
- 68 runtime/retention/lifecycle/preemption tests passed across native, QuickJS
  and worker evaluators, including Node host identity admission and Node/browser
  host ABI preemption. This is the complete test set from the prior 62-pass,
  6-missing-dependency-failure log; all 68 now pass after isolated dependency
  installation.
- Focused strict TypeScript check of managed-code-observations.ts and
  managed-recovery-safety.ts passed; git diff --check passed.
- Test runner added as npm run test:code-observations and included in
  test:recovery. Node transform-types plus the existing test loader is required.

Evidence logs are in output/yield-cell-lifetime/final-recovery.log,
final-full-runtime.log and final-typecheck.log in this checkout. Earlier failing logs
reflect missing development dependencies or an incorrect strip-types invocation;
they are retained and are superseded only by the named final checks above.
Dependency provisioning was isolated under the ignored output directory.

Coverage limits: this is a real SQLite reopen and runtime replacement test, not
a deployed Cloudflare Durable Object kill/restart journey. The SQLite adapter
uses synchronous disk transactions and a no-op storage.sync; a fault wrapper
tests acknowledgement loss after persistence. No Rust/WASM compilation or
full managed-service build/check is claimed. Production wiring and Rust schema
compatibility additionally have source inspection evidence.

Root-supplied production diagnostic 9783 (replayed=true) and the subsequent
missing wait motivate this change; this specialist could not independently read
administrator production diagnostics. The existing lifecycle tests exclude
normal completion-before-wait as the missing-cell cause.

No push, deployment, uncertain effect replay, or production mutation performed.
