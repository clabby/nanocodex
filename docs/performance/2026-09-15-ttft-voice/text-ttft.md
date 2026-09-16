# Text TTFT with setup separated

Uses the completed 144-turn run; no new text calls were made. Each cell is median **first prompt / repeated prompt**, seconds. Hosted agent creation and Codex process/thread creation are excluded. Native uses `run.started` receipt because exact CLI submission is internal. Agents API initial input is inseparable from session creation; its fresh column retains that cost. Repeats retain the previous answer and full prompt. Three samples per cell; different product-added context.

| Workload | Hosted Nanocodex | Agents API | Codex CLI | Native Nanocodex† |
| --- | ---: | ---: | ---: | ---: |
| greeting | 5.86 / 2.31 | 11.02 / 6.63 | 4.04 / 2.16 | 2.02 / 2.47 |
| arithmetic | 6.32 / 3.56 | 10.82 / 7.47 | 6.22 / 1.98 | 2.06 / 1.69 |
| extraction | 14.00 / 2.01 | 11.03 / 6.30 | 12.98 / 2.69 | 10.00 / 1.41 |
| schedule | 6.51 / 3.70 | 10.13 / 6.62 | 6.99 / 3.19 | 3.52 / 3.12 |
| long_output | 17.92 / 2.75 | 14.71 / 5.63 | 17.30 / 3.52 | 17.60 / 2.60 |
| long_context | 7.10 / 3.85 | 8.78 / 5.64 | 5.71 / 3.62 | 4.04 / 2.23 |

## What to target

- Hosted first-prompt admission is 601 ms median and follow-up admission 279 ms. Across the fixed suite, model-call-to-first-text is 5.87 s fresh and 2.32 s repeated. These independently aggregated medians are not an additive budget.
- Hosted model telemetry reports first protocol event at 2.154 s fresh versus native 0.763 s; follow-ups are 0.393 s versus 0.395 s. This identifies an early model-path difference on initial turns. It does not isolate networking, provider queueing, prefill, or relay work. Fresh native connection setup alone is 0.531 s median; equivalent hosted handshake spans were not captured in this run.
- Input context is materially different: greeting medians are 18,092 tokens hosted, 15,601 Codex, and 7,407 native Nanocodex. An experiment reducing unnecessary context is justified; the current traces do not establish how much latency it would save.
- Cached prompt authorization reported 0.0 ms for all 36 hosted submissions. Automatic personalization recall is absent in the 34 detailed traces, including one cache miss. These are not the observed large TTFT costs.
- To improve text TTFT, investigate the first model connection/initial protocol-event interval and full model input, plus remaining account/environment admission. Optimizing the separate 3.33 s agent-creation/stream setup will improve initial interaction latency but does not change the prompt-only TTFT values above.

[Full text experiment and limitations](text.md) · [Machine-readable TTFT](text-ttft.json)
