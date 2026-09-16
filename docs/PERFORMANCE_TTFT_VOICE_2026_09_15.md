# Text TTFT and voice readiness — September 15, 2026

Follow-up to the [managed API and SQL audit](PERFORMANCE_AUDIT_2026_09_15.md),
after the personalization changes through `533d013f`. The measurement task
changed no application code. Earlier performance fixes were already deployed.

## Findings

- Text: 144 completed turns, six identical synthetic workloads, four paths,
  three fresh/repeated pairs per cell. Hosted Nanocodex and both CLIs passed
  36/36; Agents API passed 34/36. Its second invoice pair repeated an incorrect
  grand total. All timings retain the incorrect outputs.
- Fresh hosted admission fell from 1.16 s in the earlier suite to 0.60 s.
  Follow-up admission stayed near 0.28 s. The before/after runs were at
  different times, and the current hosted adapter uses SDK access-token reuse;
  this is not a causal estimate of the personalization change alone.
- All 36 hosted prompt submissions used cached authorization. Detailed traces
  cover 34/36 turns: 33 prepared-profile hits and one miss that proceeded with
  zero facts and no automatic recall. Saved admission/model boundaries exist
  for all 36 turns.
- Voice response latency is close to the bundled Codex runtime in three fresh
  paired checks. Time-to-listen remains variable. The latest phone build does
  not have a successful live UI retest after the final personalization changes.

## Keep three clocks separate

1. **Text TTFT:** submitted prompt to first received assistant text. Agent
   creation and stream connection are reported separately.
2. **Voice readiness:** voice start to connected media, open control channel,
   and provider readiness, allowing the user to speak.
3. **Voice response:** end of recorded speech to first received response audio.

### Text TTFT, first prompt / repeat

Median seconds, three observations per cell. Codex runs through its CLI
app-server. Native Nanocodex uses `run.started` receipt because submission
occurs internally. Agents API first input is inseparable from session creation.

| Workload | Hosted Nanocodex | Agents API | Codex CLI | Nanocodex CLI |
| --- | ---: | ---: | ---: | ---: |
| Greeting | 5.86 / 2.31 | 11.02 / 6.63 | 4.04 / 2.16 | 2.02 / 2.47 |
| Arithmetic | 6.32 / 3.56 | 10.82 / 7.47 | 6.22 / 1.98 | 2.06 / 1.69 |
| Extraction | 14.00 / 2.01 | 11.03 / 6.30 | 12.98 / 2.69 | 10.00 / 1.41 |
| Scheduling | 6.51 / 3.70 | 10.13 / 6.62 | 6.99 / 3.19 | 3.52 / 3.12 |
| Long output | 17.92 / 2.75 | 14.71 / 5.63 | 17.30 / 3.52 | 17.60 / 2.60 |
| Long context | 7.10 / 3.85 | 8.78 / 5.64 | 5.71 / 3.62 | 4.04 / 2.23 |

All use `gpt-6-astra`, low effort and default speed. Product-added context and
serving paths differ. Exact prompt hashes, workloads, timing boundaries,
input/cache counts, correctness, and full completion timings are in the
[detailed text report](performance/2026-09-15-ttft-voice/text.md).

### Voice readiness and response

`gpt-live-1-codex`, `cove`, identical prompt and prerecorded speech; three
interleaved pairs, all successful, stable deployment throughout.

| Metric | Nanocodex | Bundled Codex |
| --- | ---: | ---: |
| Start to listening, median | 1.802 s | 1.345 s |
| Listening range | 1.722–4.864 s | 1.002–2.091 s |
| Speech end to first response audio, median | 1.131 s | 1.087 s |
| Response range | 1.075–1.179 s | 1.048–1.375 s |

The 4.864 s call spent 2.558 s in the relay/provider path and 0.876 s outside
the measured server handler. Its inner relay span was not captured, so this
is not labeled a proven cold-container start. All three managed/egress calls
were correlated; inner relay detail covers one call.

Browser and Swift readiness logic make listening active before durable task
setup completes; delegated work waits separately. Three browser readiness
tests and the focused Swift delayed-admission test passed. In the live voice
sample, durable admission completed before media readiness on all three calls.

These are browser WebRTC measurements using the native runtime, not phone
UI timings. Browser/process launch, initial agent/thread creation, module
loading and physical microphone permissions are excluded. Response audio uses
received audio energy, not physical speaker acoustics. See the
[voice report](performance/2026-09-15-ttft-voice/voice.md).

## Next measurements and optimization targets

- Voice: locate the slow relay/provider and dispatch intervals, then verify
  immediate speech acceptance at the listening transition on the phone.
- Text: investigate initial model-request latency and unnecessary context.
  Hosted first protocol-event timing was 2.154 s versus native 0.763 s, while
  repeats were about 0.394 s on both. This does not isolate network, queueing,
  prefill, or relay time. Greeting input context was about 18.1k tokens hosted,
  15.6k Codex, and 7.4k native Nanocodex; no causal token-removal saving is claimed.
- Remaining hosted admission is 0.601 s fresh / 0.279 s repeated. Separate
  hosted creation/stream setup costs 3.33 s median. Improving creation helps
  initial interaction latency but does not change the prompt-only TTFT above.
- Voice credential round trips were 163–185 ms despite in-memory broker hits.
  Post-SDP media work remains measurable. Proposed changes need controlled
  tests; these measurements are not promised savings.

## Evidence and limits

[Selected data, plots and reproduction notes](performance/2026-09-15-ttft-voice/README.md)
include 144 per-turn measurements and six voice calls. The local evidence
archives retain account-specific raw events and machine-specific harnesses in
`output/ttft-rebenchmark-20260915/` and `output/voice-recheck-20260915/`.

All temporary managed/Agents API sessions were deleted, binary hashes remained
unchanged during each experiment, and deployment history showed no changes.
Three samples per cell do not establish percentiles or consistent parity.
These runs do not remeasure tool execution, forced cold containers, or SQL
statement timings. Existing SQL churn remains a separate finding from the
previous audit.
