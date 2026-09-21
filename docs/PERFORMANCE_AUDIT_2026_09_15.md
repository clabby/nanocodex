# Managed API and voice performance audit — 2026-09-15

This is a measured component audit, not a claimed optimization result. Local
raw traces, harnesses, deployment receipts and the detailed report are under
`output/api-audit-20260915/` in the main development checkout (not committed,
including account-specific runtime context). Primary files: `REPORT.md`,
`compact.json`, `compact-deep.json`, `voice-components.json`, `FOLLOWUP.md`.

## Workloads and boundaries

- Primary sample: six fresh agents, two turns each: no model tools, local
  `/brain` tools, and fresh Cloudflare sandbox plus retained-hand follow-up.
  All completed with expected answers and all agents were deleted. One sandbox
  mount failed and was retried; it remains in the measurements.
- Separate initial replication: 16 turns, eight agents, all completed/deleted.
- Two create→prompt/SSE/cancel journeys; four browser speech calls; one fresh
  physical iPhone startup. The phone regression test failed afterward on mute;
  a repeat failed before voice controls appeared.
- Follow-up semantic-search sample: two agents, four turns, all completed/deleted.
- SQL-off control: two agents, four turns, correct answers, all deleted.
- Prompt timing starts after create and event subscription. Model duration
  includes connection time. Parallel startup spans and nested tool calls are
  not added together. Browser media readiness is distinct from the combined
  start promise that also waits for durable admission.

Primary managed version `561920f5-8ca2-4a27-b9b8-994e1faf90a6`, egress
`6ca81e1d-6874-47c1-92c7-b6b63742a555`; start/end receipts match. Follow-up
managed version `b90a2d4c-4419-43cb-8e3b-560031f54909`. Model: subscription
`gpt-6-astra`, low effort, standard service. These are small samples, not
production percentiles or bare-provider benchmarks.

## API costs (primary sample)

| Operation | Median | Range |
|---|---:|---:|
| Create | 1,394 ms | 1,204–1,951 ms |
| Delete | 2,336 ms | 2,044–2,597 ms |
| Get agent | 64 ms | 39–133 ms |
| List with access token | 253 ms | 251–285 ms |
| Settings PATCH | 66 ms | 40–78 ms |
| Prompt acceptance | 110 ms | 82–170 ms |
| Get turn | 58 ms | 39–465 ms |
| Event history | 467 ms | 62–1,151 ms |
| WebSocket ready | 1,009 ms | 801–1,153 ms |

Separate SSE first frames: 335/362 ms. Cancellation terminal observed in
349/216 ms. Public `POST /v1/agent-runs` returned 404 despite a managed-handler
and SDK implementation; separate create/prompt works. This audit did not fix
that routing gap.

## Largest measured components

1. Model duration: 1.60–17.73 seconds per primary turn. Multi-tool workloads
   require multiple model calls. This includes transport/provider wait.
2. Sandbox provisioning: successful fresh mount 4,631 ms, including egress
   binding 926, workspace readiness 2,533, alias 26, brain mount 659 and desktop
   readiness 487 ms. Another attempt failed after 2,867 ms, then retried in
   6,329 ms. Warm command whole-tool time was 525–529 ms, versus reported
   command wall time 170–190 ms. Do not duplicate parent/child mount spans.
3. Voice stop: 231/6,506/3,795/348 ms. The slowest spent 6,411 ms inside the
   Session receiver. Its runtime-end/serialization subspan is unresolved.
4. First-turn history lookup: 458–6,503 ms. Follow-up instrumentation measured
   2,985 ms caller time with 2,754 ms inside external semantic search. Another
   lookup was 576 ms with 298 ms semantic search. This confirms a real external
   dependency on first-model startup; it does not retroactively split the
   earlier 6,503 ms outlier. Warm admission still took 262–515 ms.
5. Create dispatch/activation residual: 672–1,556 ms outside the measured
   Session receiver, which itself took 279–358 ms. Receiver invocation CPU was
   30–71 ms. Residual is not proven SQL or network time.
6. Delete container cleanup: 893–1,339 ms. Even agents with no hand paid
   904/1,178 ms for legacy-container cleanup. Second registry deletion added
   168–188 ms. These are measured candidates for eliminating unnecessary calls.
7. First text-model credential RPC: 159–1,212 ms across six exact object joins,
   while the broker's queue/handler/activation clocks were zero. Warm voice
   credential RPC was 168–183 ms. The normal credential is already in memory;
   this is not evidence for repeated credential SQL reads.

Cached signed-access authentication measured 0 ms at production clock
resolution. Live auth on the first primary create took 194 ms. Session
ownership and model credentials are separate from this snapshot verification.

## SQL counts

Whole owned Session lifecycle, including two turns, schema initialization,
reads, persistence and deletion; shared account/memory traffic is not blindly
assigned by time window.

| Workload | SQL executions | Rows read | Rows written |
|---|---:|---:|---:|
| No tools, sample 1 | 902 | 4,548 | 375 |
| No tools, sample 2 | 895 | 4,529 | 375 |
| Brain tools, sample 1 | 2,251 | 6,366 | 605 |
| Brain tools, sample 2 | 2,225 | 6,340 | 605 |
| Sandbox with retry | 3,423 | 8,053 | 760 |
| Sandbox, sample 2 | 2,830 | 7,106 | 636 |

The full `managed_turns WHERE id = ?` SELECT executed 5,328 times across these
six agents: 114–115/no-tool agent, 1,163–1,189/brain agent,
1,233–1,514/sandbox agent. `#activeTurnAuthorization` reads that row, and tool
availability/permission callbacks repeatedly request it. This is a concrete
read-reuse candidate, not a measured milliseconds saving or complete caller
attribution. Other repeated reads include root-agent identity (627), session ID
(522), hosted-tool routes (476), and full session state (466).

Each browser voice ownership check made exactly two SELECT statements, read two rows,
and wrote none. Receiver time was below resolution; RPC time was 14–270 ms.

All per-SQL timing fields were zero because the Workers clock does not advance
for synchronous CPU. Zero does not mean free. Use invocation CPU as a coarse
bound, not per-statement time; it also includes JSON/runtime/audit work.
See [Cloudflare performance API](https://developers.cloudflare.com/workers/runtime-apis/performance/).
The audit records counts/rows without bindings/results and preserves native
receivers/cursors/transactions. SQLite-internal FTS/KV activity is not a
separate intercepted statement. Logs are batched to reduce truncation risk.

## Voice readiness and failures

Browser `gpt-live-1-codex`/`cove`, four calls: media ready at
4,443/2,849/2,307/1,664 ms. The first relay was stopped; the others were running.
Cold container-boundary time outside Node fetch was 2,154 ms. Across calls,
median upstream response wait was 445 ms, post-SDP media setup 393 ms,
managed→egress residual 342 ms, credential RPC 179 ms. Per-call components sum
to observed media readiness; medians do not necessarily sum.

Three calls returned speech. The fourth sent 27,304 bytes but received no
speech/transcript within 15 seconds despite HTTP 201 and connected media.
This failure remains unresolved. On call 2 the combined start promise returned
at 3,610 ms, after media-ready at 2,849 ms. Do not conflate those boundaries.
Transcript-tail delegation acknowledgements during close took 307–385 ms;
this is not a tested voice-command→durable-task-completion workflow.

The phone's own log measured 2,692 ms tap→ready: 54 ms before call, 1,912 ms
HTTP call, 362 ms answer application and 365 ms remaining media setup. The
subsequent UI failure means it is not a full speech/mute/minimize pass.
Earlier native Codex warm readiness was 1,126 ms in separate traces; it was
not remeasured here. These results do not establish consistent native parity.

## Final state and limits

SQL tracing was explicitly disabled in managed deployment
`920a4bef-9a83-4673-a896-6b7030d83365`; source maps restored and container
rollout disabled. The SQL-off control emitted zero SQL audit records for its
owned objects. Create remained 1,404–1,462 ms; prompt acceptance 73–108 ms.
Model variation prevents a causal estimate of instrumentation overhead.

Validation: managed/egress typechecks, initial 82 focused tests, 30 sandbox
checks, 18 compact-SQL/ownership tests, five deletion tests, 11 MemoryScope
tests, and completed real journeys. Mobile UI checks failed as documented.

This measures the requested agent lifecycle/prompt/voice paths, not every
billing/connector/export/multiplayer/device endpoint, every mobile state,
individual SQL CPU cost, or production p95. Next fixes should target the
measured calls above and be remeasured; no runtime optimization is bundled
with this observability change.
