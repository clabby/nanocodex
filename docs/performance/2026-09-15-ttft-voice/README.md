# Published TTFT and voice evidence

Start with the [findings](../../PERFORMANCE_TTFT_VOICE_2026_09_15.md).

- [Text experiment, setup, completion, correctness and cache data](text.md)
- [Text TTFT with setup separated](text-ttft.md)
- [Paired voice readiness and response](voice.md)
- [144 per-turn text measurements](measurements.csv)
- [Synthetic prompts, hashes and answer oracles](workloads.json)
- [Text distributions](text-summary.json), [component summaries](text-components.json),
  [selected stage traces](text-stage-traces.json)
- [Six voice measurements](voice-summary.json), [selected voice spans](voice-components.json)
- [Manifest](manifest.json), [text validation](validation.json),
  [voice verification](voice-verification.json), [trace coverage](trace-validation.json)

Run `python3 docs/performance/2026-09-15-ttft-voice/reproduce.py` from the repository
root to validate the published counts, prompt hashes, per-cell TTFT medians and
voice timing arithmetic. It makes no network calls and prints the text and voice
comparison tables. This recomputes the selected metrics; independent checking of
actual output text and transport events used the original local evidence.

Account-specific raw model events, complete product-added instructions, shared
Worker tails, local filesystem/environment configuration and machine-specific
live harnesses remain in the main development checkout under:

- `output/ttft-rebenchmark-20260915/`
- `output/voice-recheck-20260915/`

The earlier baseline remains in `output/ttft-extended-20260915/`. The public
measurements contain selected numeric fields and synthetic workloads. Exact
model output is not included; correctness comes from the independently validated
raw run. The local harnesses were retained unchanged for audit, rather than
presented as a portable benchmark tool.

Three observations per path/workload are descriptive. Readiness is not response
latency; fresh sessions do not imply forced cold containers or provider caches.
See the reports for timing boundaries, missing traces, and phone-test limits.
