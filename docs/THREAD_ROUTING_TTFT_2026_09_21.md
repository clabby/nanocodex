# Scheduled TTFT routing — 2026-09-21

New full-account managed agents now default to Jev routing when `NANOCODEX_AUTO_ROUTING=true`, `NANOCODEX_THREAD_ROUTING=true`, and the AI binding is available. Explicit model settings, existing routing policies, durability imports and constrained Connect grants retain their previous behavior. New roots and children receive trusted telemetry before selection; existing routes remain pinned.

## Recurring measurement

The managed Worker has a `*/30 * * * *` UTC cron. A single SQLite Durable Object, `ProviderProbeCoordinator`, owns scheduling deduplication, the daily request budget and aggregate measurements. It probes all configured API candidates: three Workers AI GLM efforts and fifteen model/effort combinations through each of OpenRouter and Vercel, for 33 targets with both secrets present.

Each request uses a nonce and a versioned synthetic “OK” prompt, streaming enabled, the exact candidate reasoning effort, a 128-token completion ceiling and a ten-second deadline. The default daily cap is 1,600 requests; a complete day requires 1,584. `NANOCODEX_PROVIDER_PROBE_DAILY_LIMIT` can lower it; the hard ceiling is 4,096. These are request caps, not dollar budgets. Provider key spending limits still apply. No fallback model, larger output allowance or retry is used for a failed probe.

Set `NANOCODEX_PROVIDER_PROBES=false` to stop probe requests. A duplicate cron delivery, including after a Durable Object restart, cannot spend a second sweep in the same half-hour slot. An interrupted sweep is not retried within that slot. Requests reserve budget before dispatch, including failures. Missing keys remove the corresponding targets. The namespace and migration are included in the Worker configuration.

Shared probes cannot use a globally owned ChatGPT subscription credential. The twelve ChatGPT model/effort choices remain eligible, with background TTFT unknown. The API gateway measurements must not be assigned to ChatGPT just because its canonical model matches.

## Meaning of TTFT

TTFT is measured from dispatch to the first complete SSE event with nonempty generated text or plaintext reasoning. Headers, empty role deltas, heartbeats and encrypted reasoning metadata do not count. UTF-8 and SSE framing work across arbitrary chunks; malformed streams, provider errors, missing terminal frames and timeouts are censored. A valid length-limited terminal can supply TTFT if generated text arrived. Workers AI's usage-only terminal trailer is handled separately without inventing an HTTP status.

The measurement describes observable upstream generation, including network time, from the probe executor. It is not browser delivery time, buffered agent response latency, full-task duration or task completion probability. Probe geography is explicitly deployment-global and unknown; ingress location is not relabeled as execution location. Live and probe measurements stay separate.

Jev receives candidate-matched p50/EWMA TTFT only after three successful samples within two hours. At the normal cadence, a cold deployment first qualifies after about one hour. Availability failures remain separate evidence, including when no TTFT qualifies. Recent failures cannot refresh stale successful measurements. Missing or insufficient measurements remain unknown. Latency does not bypass candidate restrictions or measured task-success thresholds.

The complete telemetry projection is retained in the route audit. Jev receives compact per-candidate responsiveness and availability fields, avoiding duplicate aggregates. The initial expanded input was rejected by live Jev; the compact full-catalog input was accepted. This is important when every candidate has measurements.

## Verification

- 123 routing, telemetry, schedule and admission tests; 24 streaming probe/store tests; two real Rust/WASM routing tests; seven Worker-runtime coordinator/admission tests; managed TypeScript check pass.
- The actual `nanocodex2` binary passes two turns against the local PR Worker with automatic admission and a retained route. A keyless workerd fixture verifies all 33 scheduled targets, slot deduplication across runtime recreation, private aggregate projection, async child admission, disabled scheduling and the shared daily cap. It seeds repeated synthetic samples to test the three-sample admission threshold; it does not wait an hour or claim live provider coverage.
- A live three-sweep development cohort attempted all 33 API candidates three times: 95 of 99 streams succeeded, with three network failures and one timeout. All 33 combinations produced at least one successful stream; 29 had three successes in this cohort. Failures were retained and did not count as fast responses.
- Real Jev accepted the measured 45-candidate catalog. Two development tasks returned eligible proposed routes at low confidence, retained under the existing `proposed` fallback policy. This verifies plumbing, not decision quality or calibrated success probability.
- In a separate controlled test with the same GLM/high model on two gateways, real Jev chose OpenRouter for a synthetic 100 ms versus 8,000 ms TTFT pair (confidence 0.99), then Vercel after reversing the measurements (confidence 0.78). Both were accepted without fallback. These synthetic reversals establish sensitivity to latency, not a production performance ranking.

Live measurements above were collected from the Mac development runner, with the real Cloudflare binding and authenticated gateways. They are not globally deployed Worker measurements or held-out task benchmarks. The local binding proxy could not serialize an AbortSignal; its diagnostic wrapper omitted that option while retaining the probe deadline. Production Workers AI binding supports the signal directly.

The configuration enables automatic routing and the recurring schedule **on deployment**. This follow-up updates PR #436; it does not itself deploy the PR or activate the production cron.

Main-thread provider/model selection happens once, before its first inference, and remains pinned across continuation, reconnect and restart. Probe changes and provider failures never switch an existing conversation. Newly spawned subagents route independently and retain their own routes. Reasoning effort is currently locked on routed threads too: any future mid-thread effort change must use a verified appended-token mechanism that preserves the existing prompt-cache prefix; changing a request parameter alone is not sufficient. A SQLite regression reverses provider/model/effort latency rankings and verifies the retained root does not change while a new route sees the updated measurements.
