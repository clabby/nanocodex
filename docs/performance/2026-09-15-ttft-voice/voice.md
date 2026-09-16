# Voice responsiveness and text TTFT — September 15, 2026

## Assessment

Voice replies are close to the bundled Codex runtime in this small sample. Voice readiness is usually below two seconds but still has an unacceptable slow start relative to that target. This is not a mobile latency sign-off. Text TTFT should be assessed separately from creating an agent and connecting its stream; see [prompt-only text TTFT](text-ttft.md).

## Fresh paired voice check

Three interleaved pairs on one stable deployment; `gpt-live-1-codex`, voice `cove`, identical backend prompt and prerecorded speech. All six calls returned “Ready.” with received audio and no reported failures. The three owned managed agents were deleted.

| Measurement | Nanocodex | Bundled Codex |
| --- | ---: | ---: |
| Voice start → ready to accept speech, median | **1.802 s** | **1.345 s** |
| Readiness, all observations | 4.864 / 1.722 / 1.802 s | 2.091 / 1.345 / 1.002 s |
| End of recorded speech → first received audio, median | **1.131 s** | **1.087 s** |
| Response latency range | 1.075–1.179 s | 1.048–1.375 s |
| Call request → SDP answer, median | 1.125 s | 0.659 s |

The response-latency median difference is 45 ms; n=3 does not establish equivalence or a reliable speed advantage. Readiness and response are different clocks: a quick reply after connection does not excuse a slow time-to-listen.

### Timing boundaries

- Readiness requires a connected peer, open control channel and provider `session.started`. It is not the call-RPC acknowledgement or the durable-admission promise.
- Both paths use the same Chrome/WebRTC environment on this Mac. Codex is the installed ChatGPT-bundled `0.154.0-alpha.6.2` runtime; Nanocodex uses the current built browser core from source `533d013f` and deployed services. This is not a direct phone-versus-desktop UI test.
- Browser/process launch, initial agent/thread creation, app-origin/state preparation and WASM module loading occur before the voice-start clock. Physical microphone permission, device capture startup and speaker acoustics are not measured: a prerecorded 1,251.917 ms fixture is injected, and decoded audio energy is polled every 20 ms.
- Voice response latency subtracts fixture duration from fixture-start-to-first-audio. It does not isolate speech endpoint detection, inference, network and playout individually. The fixture is injected after session startup completes; in all three Nanocodex calls durable admission had already completed before media readiness.
- Fresh browsers and agents do not force cold provider caches or stopped relay containers. Host load was recorded; the workstation was shared. No p95/p99 claim is supported.

## The slow startup, without guessing its cause

Trial 2 reached readiness at **4,863.7 ms**. Client/Server-Timing and correlated egress logs give this additive breakdown:

| Component | Milliseconds |
| --- | ---: |
| Egress relay/provider path | **2,558.0** |
| Client/front-door residual | **875.5** |
| Managed-to-egress residual | **490.0** |
| Client work before call request | **316.8** |
| Post-SDP media setup | **254.1** |
| Credential broker round trip | **185.0** |
| Ownership round trip | **184.0** |
| Response-body read | **0.3** |
| Auth and validation | **0.0 reported** |
| **Total** | **4,863.7** |

The slow call's inner relay log was not captured. Therefore the 2,558 ms cannot be split into container activation, dispatch, sockets and provider response wait. It is **not a proven cold-container start**. Residuals include uninstrumented work and transport; the client residual can also include browser/Playwright request routing, not just network or server time.

All three managed and egress calls were correlated by request/session ID. Inner relay coverage is only **1/3**; missing spans remain unknown. That fully correlated 1,722 ms call showed a running relay process, 314 ms provider response wait, 324 ms post-SDP media work, 283 ms managed-to-egress residual, 278 ms before the call request, 164 ms credential RPC and 101 ms container boundary residual. See [exact components and versions](voice-components.json).

All three voice call requests used cached managed authorization, reported as 0 ms. Credential RPCs took **185 / 164 / 163 ms**, while broker method/activation timers reported 0 ms. That locates a recurring round-trip cost; it does not prove expensive credential database reads.

## Can the user speak as early as possible?

The architecture already separates listening from durable agent preparation:

- Browser `VoiceSession.mjs` starts media and durable admission concurrently. `onReady` fires once media/control/provider readiness is established; `browser/Voice.mjs` publishes public active status from that callback.
- Swift `becomeActiveIfReady` activates the microphone and sets `.active` after peer/control/provider readiness. Conversation/event readiness gates delegated work separately.
- Three targeted browser readiness tests passed. The Swift test `testListeningDoesNotWaitForTaskSetupButDelegationDoes` passed with delayed admission/event setup. These are protocol checks, not a successful live iPhone journey.
- Durable admission finished at **1,460 / 1,466 / 1,503 ms**, before media readiness in each fresh voice observation. It was not the limiting startup dependency in these calls.

Source: [browser media readiness](../../../js/nanocodex/browser/VoiceSession.mjs), [public browser active state](../../../js/nanocodex/browser/Voice.mjs), [Swift microphone activation](../../../apple/NanocodexVoice/Sources/NanocodexVoice/VoiceSession.swift).

The latest installed iPhone build still lacks a successful live UI retest after the final personalization changes; that earlier attempt was cancelled while connector settings were on screen. This run did not touch the phone. Browser timings cannot certify tap-to-listen on mobile or that the first spoken word is never clipped.

## Priorities supported by the evidence

1. **Voice time-to-listen:** attribute the slow relay/provider block and the dispatch/client residuals; reduce the observed startup variability. Capture the missing receiver/relay stages before deciding that prewarming alone fixes it.
2. **Text TTFT:** investigate the initial model-request path and unnecessary model context. The text run's first protocol event arrives at 2.154 s hosted versus 0.763 s native, while follow-ups are both about 0.394 s. These are model event timers, not isolated network spans. Input context also differs materially. See the text report for bounds and per-workload medians.
3. **Recurring voice overhead:** the credential round trip and post-SDP media work are real measured costs. Their removal or overlap needs a controlled experiment; no savings are promised here.
4. **Mobile readiness:** verify actual tap-to-listening and inject speech immediately at the listening transition on device. Existing boundary tests establish readiness independence, not end-to-end phone performance.

Voice response latency itself is close enough to the native reference in this sample that startup consistency deserves more attention. This run contains no tool/delegation voice task, interruption/barge-in test, or forced cold-start experiment.

## Published evidence

- [Six per-call measurements and summaries](voice-summary.json)
- [Selected component traces](voice-components.json)
- [Verification results](voice-verification.json)
- [Runtime hash, prompt hash, scope and timestamps](manifest.json)
- [Text TTFT with setup separated](text-ttft.md)

Full raw calls, speech captions, local harnesses, deployment receipts and Swift test output remain in local `output/voice-recheck-20260915/`. All four services remained unchanged throughout the run. No application source was edited or deployed by this measurement task, and no mobile installation was performed.
