# Claude-native runtime

`nanocodex-claude` implements a separate Messages-based backend behind the common `nanocodex-agent` lifecycle. Tool registration is explicit; it never imports the OpenAI tool catalog or Claude Code credentials. Embeddings supply authentication and host-authorized capabilities.

## Context and compaction

The active estimate starts from the latest reported input, cache-read, cache-write and output usage. Newly queued text and tool receipts add a UTF-16 text estimate until the next provider response supplies an updated usage anchor. The configured automatic window is a trigger, not a guarantee that the preserved payload fits that size. The current reserve remains 20k output plus 13k headroom for supported coding models.

Compaction summarizes the earlier prefix while preserving a pending assistant/tool round, including its signed thinking, opaque fields and complete tool results. Paused server-tool content is retained without fabricated client results. If this is the first tool round, the original user task is the summary prefix. A prior summary participates in later compaction, including repeated manual compaction with no intervening turn.

Summary requests retain the tool catalog for caching but set `tool_choice: {"type":"none"}` to prevent provider-side tool execution. A summary is validated before replacing context. Failed summaries retain the original state; a successful summary is checkpointed before continuation. Automatic summary usage contributes to the successful turn's usage totals. Rebuilt context receives an estimate for the summary, retained messages, system context and tools.

Automatic compaction suppresses an unchanged boundary after a failed continuation. New assistant rounds can make progress and trigger another summary during the same user turn. A bounded local refill policy allows two rapid summaries, then waits for three advancing assistant responses. This is an explicit local policy, not the CLI's exact breaker implementation. The existing turn limit is sixteen main model calls.

## Prompt caching and discovery

Caching is opt-in through `automatic_cache(true)` or `cache_one_hour()`. The request builder also places a stable system-prefix breakpoint when the cache budget and caller policy permit it. Explicit caller system markers are preserved. A provider cache hit, minimum token eligibility, expiry and billing remain provider decisions.

Before authentication or HTTP, requests validate cache markers in tools → system → messages order: no more than four effective breakpoints, valid TTL/type, longer TTL before shorter TTL, and valid automatic/final-marker combinations. Thinking and empty text cannot carry direct markers. Tool-result cache controls and signed thinking metadata survive round-trip serialization.

Custom `ToolSearch` returns standard tool-result references. All registered definitions stay in a stable top-level catalog with their original deferred flags; discovery does not promote them into the eager prefix. Rejected discovery options do not activate tools. After successful compaction, the execution-discovery set is intersected with authentic ToolSearch references still present in the retained suffix. Discarded references require fresh discovery; failed compaction leaves discovery unchanged. The implementation follows the public [custom tool-search protocol](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool#custom-tool-search-implementation) and [tool caching behavior](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching).

The live CLI uses additional request fields and message roles. The library uses public Messages representations rather than copying those fields. General policy follows [Anthropic's caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); synthetic tests establish request behavior, while the separate live trace establishes observed CLI cache reuse.

## Tools and recovery

Client tool identities are admitted once per session and survive compaction. Reuse of an admitted ID fails before handlers execute. Sequential and queued parallel calls check cancellation before starting another handler; completed receipts survive cancellation or a failed follow-up. Interrupted work receives an explicit unknown-outcome receipt. This is in-process protection, not durable idempotency across crashes, nor semantic deduplication of different IDs.

Completed provider-side tool receipts are checkpointed even when a valid response ends with an unsupported stop or cancellation. Interrupted server-tool streams retain an explicit unknown-outcome notice and any observed container identity; they do not synthesize a completed assistant or server-result block, and are not automatically retried. Provider code-execution containers are retained whether their identity arrives in the initial message or final delta. The embedding host remains responsible for persistence, authority and sandboxing. Dropping a blocking filesystem future does not guarantee the underlying operation stopped.

The optional workspace adapters support bounded UTF-8 files, exact edits, a simple Unicode glob subset, scoped regex search, notebooks and session-local tasks. Unsupported mutation options fail before changes. Edit expansion is checked before allocation; directory traversal bounds both queued and visited entries. Task mutations preserve the readability of bounded TaskGet/TaskList results and reject oversized updates atomically.

Bash requires an injected sandbox executor; web tools require explicit provider/page-source capabilities. Auxiliary WebFetch accepts multiline prompts. WebSearch/WebFetch bound output while reserving source attribution; an oversized source set fails explicitly rather than silently dropping citations.

## Coverage and limits

The behavioral suites exercise loopback HTTP/SSE, real local file mutations and failure recovery through public adapters. Live interactive Claude Code measurements are separate from these tests. They do not establish live Nanoclaude subscription authentication, every CLI tool, every model, or exact prompt/compaction parity.

Recovery limits remain explicit: a first-turn interrupted-server notice has no completed assistant boundary and can be paraphrased or omitted by a later summary. Lossless retention of that notice through compaction is not implemented. The fallback estimate after an unknown/invalid response counts message JSON but omits fixed system/tool overhead until the next successful usage anchor. Invalid-response evidence is capped at 64 KiB with a truncation/unknown-effects marker; valid completed boundaries remain intact.

Remaining larger capabilities include host subagent lifecycle, durable effect receipts, background shell/output/stop tools, multimodal/PDF Read, and host-integrated question/plan/worktree/MCP surfaces. See [the tool matrix](CLAUDE_TOOL_MATRIX.md) for the current catalog and [interactive compaction measurements](research/nanoclaude-auto-compaction-measured.md) for the observed reference behavior.
