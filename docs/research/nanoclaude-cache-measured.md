# Interactive prompt caching — 2026-09-29

Eleven synthetic prompts, including two manual `/compact` commands, ran in the actual Claude Code **2.1.283** TTY on the returning Mac. Sessions used Sonnet with low effort, safe mode, empty setting sources/MCP configuration, and a 100k automatic-compaction setting. The CLI used its own login. No print-mode calls were used.

A process-local TLS relay retained structural shapes, cache-marker locations, digests, numeric usage and tool IDs. It did not retain credential/header values or full private prompts. All experiment sessions were stopped and their temporary TLS keys removed. This is CLI reference evidence, not a live test of Nanoclaude authentication.

## Cache reuse and compaction

The Read-only baseline kept its tool catalog unchanged. Ordinary requests marked two system segments and a moving final message boundary with one-hour TTLs. The initial ordinary turn wrote 922 tokens and read 5,734; the next wrote 66 and read 6,656. The marked system digests stayed stable. A different unmarked system block changed despite successful reuse, so whole-request byte identity is not a cache-hit test.

A Read continuation reused 6,795 tokens and wrote 5,335; its call/result IDs matched. Manual compaction retained the catalog but omitted TTL on its three markers, including a marker moved back to the prior assistant/tool boundary. Usage reported 93 new five-minute tokens, 6,795 cache-read tokens and 7,265 uncached input tokens. The result following that boundary remained in the summary input. The post-compaction main request returned to one-hour markers and reused 5,734 static-prefix tokens.

Short runs establish immediate reuse, not actual expiry time. These measurements include CLI-specific system message roles and cache scopes, which are not copied into the public backend.

## Deferred discovery

The first attempt with explicit `--tools Read,ToolSearch,Glob,Grep` did not activate ToolSearch. That failed activation is not counted as deferred-discovery evidence.

With `ENABLE_TOOL_SEARCH=force --tools default`:

| Request | Operation | Cache read | Cache creation |
| --- | --- | ---: | ---: |
| n20 | Initial main turn | 0 | 27,740 (1h) |
| n21 | ToolSearch call | 27,740 | 104 (1h) |
| n22 | Continue after discovery | 27,844 | 1,542 (1h) |
| n23 | Manual summary | 27,844 | 87 (5m) |
| n24 | Continue after summary | 23,249 | 3,687 (1h) |

The full advertised tool array changed at n22: WebFetch and WebSearch were added, both with `defer_loading:true`, and two references appeared in the matching ToolSearch result. The eager definitions and marked system digests remained unchanged. Actual usage demonstrates that adding these deferred definitions did not discard the existing prefix cache. Neither web tool was executed.

After compaction, the CLI retained its discovered catalog but removed old call/result history together. All measured historical tool calls/results were paired; no orphaned result was observed.

## Implementation consequence

The backend now keeps its complete deferred catalog stable and lets references load definitions inline, consistent with the public [custom tool-search protocol](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool#custom-tool-search-implementation). This avoids the previous promotion of discovered definitions into the eager prefix. Its public-API compaction policy requires rediscovery when reference history is discarded; that remains distinct from the CLI's private continuation packing.

The runtime also preserves a stable system cache breakpoint when caching is enabled and validates documented marker/TTL constraints. See [runtime semantics](../CLAUDE_RUNTIME.md) and [Anthropic's tool caching reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching).

Run artifacts are published under `/brain/outputs/nanoclaude/deep-pass/`: `live-cache-report.md`, `comparison.json`, `discovery-delta.json`, `structural.jsonl`, relay/analyzer scripts and launch flags. Trace SHA-256: `2ed7d1fe18619b48c1adf741fa656d4c760825af9950efedf84d5fb928586657`. Generated trace data is not committed.
