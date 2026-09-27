# Direct ChatGPT voice alignment

Reference: [openai/codex 32f578485143354d1c321840a3e990aabdbaca9c](https://github.com/openai/codex/tree/32f578485143354d1c321840a3e990aabdbaca9c/codex-rs), fetched September 27, 2026.

The comparison covers the ChatGPT AVAS/Frameless (V3) call, control events,
transcript reconciliation, and speech delivery. It does not replace the Apple
client or change its UI.

## Provider contract

The default subscription path uses `gpt-live-1-codex`, `cove`, client delegation,
and provider-owned audio. The call uses `intent=quicksilver&architecture=avas`.
The backend prompt matches upstream byte for byte; speaking preferences remain
optional additions. No ElevenLabs synthesis is created for the default OpenAI
output provider. The transport preserves the selected ChatGPT account in both
WebRTC and standalone WebSocket authentication.

Reference files: `codex-api/src/endpoint/realtime_call.rs`,
`codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs`,
`codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs`, and
`prompts/templates/realtime/backend_prompt.md`.

## Event and playback boundaries

Frameless completion now follows the upstream transcript accumulator: a delayed
final cannot erase newer accumulated fragments; a final that extends the text
can replace it. Live completion events remain unchanged for consumers. Handoff
input is matched after trimming surrounding whitespace so the same utterance is
not inserted twice into delegation history.

Malformed `turn.done` events are ignored before changing caption or speech
ownership state. Valid completion requires a user/assistant role and a string
transcript, as in the upstream parser.

The browser playback adapter fences asynchronous frame acknowledgement: an
older update cannot re-enable the speaker after a newer interruption. Accepted
captions remain visible. This is an adapter race fix; it does not establish the
cause of a particular user's live-call symptoms.

Native explicit speech resumes playback after typed input without restoring
ownership to an obsolete delegated answer.

## Integration differences

Nanocodex retains its managed-agent admission, durable task routing, and prepared
personalization. Prepared personalization is an embedding extension.
Codex's TUI uses client-managed handoffs with startup context disabled; Nanocodex
TUI and browser clients select that behavior explicitly. The reusable native
builder follows app-server policy defaults instead (provider-managed handoffs,
startup context enabled, and tail delegation disabled). Optional ElevenLabs adapters remain
separate from direct ChatGPT output. Matching the provider contract does not mean
these embeddings or their audio-device implementations are identical.

Automated protocol and adapter tests do not establish live microphone/speaker
quality, echo cancellation, or production deployment. A live call must verify
those separately.

## App-server lifecycle

| Boundary | Upstream reference | Alignment |
| --- | --- | --- |
| Reusable lifecycle defaults | `app-server/src/request_processors/turn_processor.rs`, realtime start | Handoffs default to provider-managed; startup context enabled; tail-flush work disabled. TUI/browser explicitly select client-managed handoffs. |
| Text appended to V3 | `codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs` | Native and browser use UTF-8-safe `session.context.append` chunks, without V2 user prefixes. |
| Standalone speech | `core/src/realtime_conversation.rs`, append speech; `core/src/realtime_context.rs` | Whitespace is ignored; browser speech now has the same 1,000 approximate-token middle-truncation budget. |
| Session instructions | `core/src/context/realtime_start_with_instructions.rs`, `realtime_end_instructions.rs` | Native start/end overrides retain lifecycle wrappers and the 8,192 approximate-token input limit. |
| Reconnect queue | `codex-api/src/endpoint/realtime_websocket/methods.rs` | Native buffered commands drain without waiting for a new socket event. Browser rejects controls from a closed/replaced transport after asynchronous classification. |
| Replacement startup | app-server/core session lifecycle | Failed browser startup cleanup cannot detach the next session's event watcher. |
| Steering and cancellation | core client-managed handoff ownership | Steering an unrelated typed turn releases cancellation ownership of the earlier voice turn. |
| Stop and history | `core/src/realtime_conversation.rs`, transcript-tail flush; `core/src/realtime_history.rs` | Stop finalizes partial captions, preserves remaining history, and does not automatically launch a backend task. Managed history writes use the stop receipt and reject conflicting replay. |

History storage remains an embedding difference: Nanocodex retains a bounded,
escaped transcript as durable background context at stop, rather than copying
Codex's app-server realtime history-item schema. The optional legacy explicit
`tailDelegation` formatter still exists; it does not make default stop launch work.
The protocol and client layers preserve independently running delegated work
when media stops. None of these checks claims JSON-RPC API identity, audio-device
implementation identity, or a verified production microphone/speaker experience.
