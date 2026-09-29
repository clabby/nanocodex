# Interactive automatic compaction measured — 2026-09-29

Current implementation details are in [the runtime reference](../CLAUDE_RUNTIME.md). The later deep pass added pending-round preservation, cache/discovery corrections and additional recovery checks; the implementation-gap paragraphs below describe the state when this measurement was collected.

This run closes the previous expired-login blocker: the actual interactive Claude Code CLI authenticated and completed three automatic compactions. No `-p` or manual `/compact` command was used.

## Configuration and evidence

The returning Mac had **Claude Code 2.1.283**, not the 2.1.284 used in earlier reports. It ran Sonnet 5, low effort, in tmux with `--safe-mode --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Read --allowedTools Read --model sonnet --effort low --autocompact 100k`. Safe mode disabled custom hooks, plugins, skills and project instructions. These controlled results do not establish default-mode or every-model behavior.

The CLI handled its existing subscription login. A process-scoped TLS relay retained structural metadata, usage, timing and tool IDs, not credential/header values or full message contents. The trace contains 31 completed HTTP requests: 14 Messages requests, 14 count_tokens requests and three startup requests. All Messages/count_tokens requests returned 200. Startup settings returned 404 and policy limits 304. Request and completion rows share an n identifier. Both experiment tmux sessions and the relay were stopped; temporary TLS keys/certificates removed; port 58329 had no listener afterward.

Run artifacts are published under `/brain/outputs/nanoclaude/auto-tty-resume/`: `structural.jsonl`, `metadata.json`, `terminal-final.txt`, and `relay.py`. Generated traces are not committed to the repository. Relay timings include relay buffering/network overhead and are not a provider latency benchmark. Summary requests were identified by instruction structure, conversation changes and terminal compaction indicators; this relay did not record request-class header values. A continuation can contain quoted summary instructions, so its compact_instruction flag alone does not classify a summary request.

## Large tool batch: preserve the pending tool exchange

Eight synthetic files were read in one model tool batch. Each source file was 88,472 bytes; Read returned 409 lines and 44,006 characters per result, so the model did not receive each full file.

- Request n6 returned eight Read calls, with reported total context usage 7,560 (input + cache creation + cache read + output).
- Before sending their results back, n15 summarized only earlier history, **excluding the pending assistant tool-use block and all eight results**. It advertised Read and used ordinary Messages, with a 6,361-character text-only instruction. It completed in 17.096 seconds.
- n16 resumed with five messages: summary-containing user context; system context; original assistant thinking and eight tool calls; one user message containing all eight results; cached system context. Every tool result matched an original ID. Result order differed from call order (positions 2,3,1,4,6,5,7,8).
- n16 reported **186,684** total context tokens and answered with all eight start labels. Thus a configured 100k auto-compaction window did not cap this retained suffix or prevent a substantially larger request.
- A new no-tools recall prompt triggered another automatic summary, n17 (29.636 seconds). n18 resumed at **10,155** tokens and recalled all eight labels.

No tool calls were reissued in these continuation responses. This observation concerns read-only effects; it is not proof of durable side-effect recovery.

## Smaller batches: estimator and turn boundary

After `/clear` in the same interactive process:

| Step | Trace request | Total reported context tokens | Compaction |
| --- | --- | ---: | --- |
| Read two files and answer | n23 | 51,632 | None |
| Issue third Read | n24 | 51,786 | None |
| Return third result and answer | n26 | 74,083 | None inside turn |
| New no-tools recall prompt | n27 | 77,662 including summary output | Automatic summary, 14.962 s |
| Recall answer after summary | n31 | 8,557 | Three labels preserved |

The source-derived nominal threshold for a 100k window is 67k. The third result was 44,006 characters: a four-character estimate adds about 11,002 to n24's 51,786, yielding about 62,788, below 67k, whereas actual subsequent provider usage reached 74,083. This is **consistent with** approximate post-usage estimation followed by an accurate usage anchor at the next turn. It does not locate an exact measured threshold or prove the chosen internal branch. Wire token counting also occurred for file reads, but this trace records only response size for count_tokens, not its returned count.

## Implications for Nanoclaude

The existing prototype compacts the entire completed tool exchange into a generic summary. This live CLI path instead preserved an unsummarized tool suffix, which can exceed the configured compaction window. Exact suffix retention, restored file context, proactive/reactive/precompute feature gates, default-mode behavior and system-role packing remain distinct implementation work.

Separately, regression work checks that automatic summarization usage is included in turn totals, queued prompts and tool receipts use consistent text estimates, and cancellation stops admission of additional side effects. These local loopback tests are not live Nanoclaude subscription tests; authentication here was exclusively performed by the installed Claude CLI.

## Matching Bun executable source

Read-only inspection of the same 2.1.283 executable (SHA-256 `d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e`) explains the observed structure. Byte offsets are zero-based and minified identifiers are local to this build.

- Configured windows route to reactive handling when supported (around 184792813). The summary split groups messages by assistant API response and initially preserves the latest group, including its following tool results (184699010, 184720150–184722711). After a newer assistant answer, the former tool round becomes eligible for the next summary.
- Reconstruction reattaches that group without checking that the payload fits the configured window (184733955); a successful compaction bypasses the immediate blocking check for the ensuing request (190748498).
- Hard blocking uses the actual model context capacity, separately from the configured compaction window (183913236). Therefore the 100k setting is neither a post-summary payload cap nor the actual provider limit.
- New precomputation is disabled for effective configured windows below 200k (183913491, constant at 178425242). Consuming an already-existing candidate is separate. Fresh reactive compaction is the strongest source-supported explanation here, but the structural trace does not contain branch telemetry.
- A rapid-refill breaker trips after repeated compactions within fewer than three counted continuing-tool-loop turns (183913654–183913999, increment at 190790898). It does not prevent the first oversized continuation. Default-mode behavior and the breaker itself were not exercised by this trial.

The full source investigation is a separate run artifact, `/brain/outputs/nanoclaude/context-branches-resume.md`. These source findings and the live trace support each other, but do not establish every runtime flag.

## Implemented corrections and validation

The backend now includes automatic summary-request usage in successful turn totals, uses the same UTF-16 text estimator for queued prompts and serialized tool receipts, and checks cancellation before starting the next sequential or queued parallel handler. Existing completed receipts remain available to recovery. Interrupted or skipped calls still receive conservative unknown-outcome errors; this is in-process recovery, not crash-durable idempotency.

Behavioral regressions reproduced failures before the fixes, including a second side effect starting after cancellation. All 44 all-feature integration tests pass, as do targeted strict clippy and formatting. Exact CLI round preservation and feature-gate behavior are documented gaps, not implemented by these corrections.
