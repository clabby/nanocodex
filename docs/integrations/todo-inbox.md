# Mobile Inbox

The bottom-left **Inbox** tab is one default mixed actionable queue: upcoming Calendar events, prepared decisions, captured tasks, review drafts, recent agent work, and Gmail conversations. It is not a permanent For you/Mail/Later tab split. The full-width app selector and “On your mind…” capture composer remain in the bottom dock.

The optional filter menu offers **Inbox**, **Mail**, **Snoozed**, **Drafts**, **Sent**, and **All mail**, with a clear-filter action to return to the mixed queue. The account menu selects all or one connected account. Search uses Gmail syntax for mail and local matching for loaded non-mail rows. Drafts are Nanocodex review drafts, separate from Gmail's native Drafts folder. The default queue shows events within the next day and recent running/ready/failed agent work updated within the last day; older conversations remain reachable in Chat. Opening agent work does not mark it done.

Rows have stable account/source identities. Email decisions use exact connection, thread, and message references, never subject matching. Linked decisions replace the raw thread row; separate message decisions within a thread remain distinct. In the mixed queue, a draft already represented by a visible thread is not duplicated. Preparations linked to an item expose their update on that item rather than a second agent-work row.

## Reading and preparing work

Opening mail shows messages, recipients, dates, readable body text, and downloadable attachments. Messages expand independently or together. HTML-only mail has an inert reader fallback; remote images and interactive content are blocked. Previous/next controls move between loaded conversations. Compose, reply, reply all, and forward open an editable recipient/subject/body editor. Forward includes message text; original attachments remain accessible in the reader, not outgoing attachments.

Account-scoped retained reads can show a previously loaded mail roster, exact-query/page list, and conversation body before live refresh, including after relaunch. Background lookahead prefetches the next three loaded conversations, at most two body requests concurrently; it is not a mailbox download. List and draft reads progress independently, with at most three accounts concurrently per read group. Successful sources stay usable when another source fails. Saved/retained-reading indicators and refresh errors distinguish these snapshots from current state.

Retained mail is presentation only. Reply/compose initiation, suggestions, and sending require successful live account, conversation (where applicable), and draft checks. Prepared approval additionally requires current matching decision context. The read cache excludes mail drafts, draft/send status, individual decision approval reads, and attachment bytes. Separate protected draft recovery preserves edits and uncertain-send locks; it does not grant authority. Cache keys include credential scope and exact connection/query/page or thread. Account changes fence asynchronous results, explicit sign-out clears reads, and acknowledged archive/Undo/send invalidate mail list/body snapshots and fence older reads. See [local-first boundaries](../../apple/LOCAL_FIRST.md).

**People & context** links to owner-private CRM profiles only after deterministic, unique exact saved-email or saved-email-alias resolution. Names, domains, historical attendee IDs, and generated prose cannot create links. Mail senders, captured literal addresses, prepared decisions, and Calendar attendees can carry this context. It includes saved name/title/company, sourced research when available, and bounded saved relationships and timeline entries. Coverage is limited to six addresses, three explicit relationships and three timeline entries per person; ambiguous, unmatched, and unavailable identities are labeled rather than guessed. Optional enrichment failure can retain a verified link. An address match is not sender authentication, a saved company link is not domain inference, and invitations do not prove attendance. Cached CRM context may be stale and is not fresh approval evidence.

Each queue item has an **AI actions** menu: **Brief me**, **Prepare next steps**, **Draft reply** for email-related items, and **Ask something else**. The request sheet attaches that item's source IDs, bounded reference snapshot, available briefing/CRM context and draft, and lets the user edit instructions before tapping **Prepare**. This submits preparation work to a linked conversation; later ready/failed updates are reachable from the item. The request explicitly permits read-only context gathering and proposals for review, not sends, bookings, spending, Vault use, policy acceptance, or external-record changes. Source text remains untrusted data. A preparation result is not an executed action or a saved sendable mail draft unless the versioned mail workflow separately creates one.

Captures and selected firehose decisions also have durable bounded preparation states (pending/preparing/ready/blocked/failed) with source references, missing-information/error reporting, and a versioned request-changes endpoint. Calendar briefings are deterministic projections of imported saved context, not automatic generative research. Routine refresh requests imported briefings only; pull-to-refresh additionally reads live calendars, with an explicit imported/partial-coverage status. Raw mail rows retain provider snippets; they do not all receive automatic generative briefings. Reading, manually composing, and explicit preparation can be available independently.

## Explicit mail actions

Draft edits recover from protected, account-scoped device storage and save to the account server. **Draft for me** explicitly requests editable reply text with no mail-sending tools. Only tapping **Send** submits the saved draft's exact version. The editor freezes during submission. A durable receipt prevents another provider send for the same draft, including after a timeout or a new operation ID. Unknown delivery stays locked and exposes a read-only status check. A version conflict preserves local edits for review rather than overwriting either version. A confirmed reply resolves only the decision for that exact original message. There is no offline send queue.

Trailing swipes offer snooze and raw-mail archive; archive and captured-task completion have Undo. Captured-task completion is versioned and durable. Agent work has an explicit Done action. None of these presentation choices authorizes an AI action.

## Snooze and coverage

Snooze/Bring back is account-private presentation state, independent of Gmail labels, read state, and task/agent completion. Mail and its linked decisions use one connection/thread reminder key; Calendar keys include connection, encoded calendar, and event IDs. Already loaded due rows return on the next visible refresh, not through a push reminder. Retained summaries and source-qualified mail disposition keys from other devices (including due reminders outside the loaded first page) are reconciled through at most five metadata reads per refresh. Checks rotate oldest-first and wait at least 60 seconds between checks of a source. This can take several refreshes to materialize a larger reminder set. Archived/removed mail is reconciled out; failures remain visible. Account, client, and cancellation fences prevent late reads from crossing sessions. Metadata only restores presentation, never send authority.

A protected atomic device journal retains exact operation IDs, versions, and pending changes before dispatch. Service acknowledgement stores the versioned disposition for other devices to read on refresh. Pending sync remains visible through outages/relaunch and retries the same operation; it is not an external-action queue. Restoration or disk-write errors are visible and do not authorize dispatch. A stale/invalid/unavailable target triggers live reconciliation and asks for review, rather than silently applying a new snooze. Account changes fence journal/network results.

The device allows at most 1,000 pending snooze commands and a 2 MiB journal. The service retains at most 1,000 distinct disposition keys, including expired/cleared versions so another device cannot resurrect old state. New keys at capacity are rejected (409); existing keys can still change. Snapshot coverage reports limit/total/returned/completeness. Source-qualified external keys are checked against owner connector inventory, not provider mail/event existence; this does not prove source freshness. Accepted new snooze times must be in the future and within 366 days.

Foreground entry, pull-to-refresh, and a 30-second loop while visible refresh the queue; search is debounced by 300 ms. Calendar and mail failures appear alongside usable sources under **Sync & coverage**. This is a bounded view: 25 conversations per account/page with explicit Load more, up to 100 saved review drafts, up to 200 captures and 200 open decisions (plus bounded completed activity), and a next-14-days Calendar request with partial-coverage indicators. The default queue narrows displayed events to the next day. Large provider responses can fail the bounded reader instead of silently appearing complete. An empty queue or retained snapshot does not mean caught up; background watch/import health remains unverified.

This implementation is not full Superhuman parity. Universal automatic generative raw-mail briefing, true offline sending, outgoing file attachments, rich-text editing, Gmail-native draft synchronization, and verified whole-mailbox/background-ingest coverage are not supplied by this Inbox. These docs describe the current source implementation, not a deployment or phone-install receipt.

## Account API

All routes below are under `/v1/todo`, authenticated to the account owner's data, and unavailable to Connect grants or service principals. Reads require `agents:read`, mutations require `agents:write`; browser mutations require same origin. Provider credentials remain in managed connector egress. Clients send exact opaque connection IDs when selecting an account.

| Route | Contract |
| --- | --- |
| `GET /` (without a trailing slash) | `{items, decisions, traces, feed_bounds, source_coverage, dispositions, disposition_coverage}`. Preparations are attached to items/decisions; source coverage is bounded/unknown, not watch health. |
| `POST /` (without a trailing slash) | `{body, watch_hint, operation_id}` saves a thought and queues preparation. Saving does not authorize external actions. |
| `GET /items/{id}` or `/decisions/{id}` | Current item/decision with preparation and source coverage, for live review. |
| `POST /items/{id}/prepare` or `/decisions/{id}/prepare` | `{version,text,operation_id}` requests new preparation (202); stale versions or mismatched operation replays conflict. |
| `PATCH /items/{id}` | `{version,status: "done" \| "captured" \| "parked",operation_id}` updates a capture. Exact retries return the original receipt. |
| `POST /decisions/{id}/respond` | `{version,choice_id,text,operation_id}` records one choice or instruction. It does not send email or execute a workflow. |
| `POST /snooze` | `{row_key,until,version,operation_id}` returns `{disposition}`. `until` is Unix milliseconds or `null` for Bring back; initial version is 0. Exact retries return the original receipt without rolling state back. |
| `GET /mail/accounts` | `{accounts:[{connection_id,label,email,capabilities,scopes}]}`. |
| `GET /mail/threads?connection_id=&q=&page_token=` | `{threads,next_page_token}`; summaries include source identity, sender/date/snippet/unread/count and bounded CRM context. |
| `GET /mail/threads/{id}?connection_id=` | `{thread:{id,connection_id,subject,messages,...}}`, including readable bodies, reply headers, completeness flag, attachment metadata, and bounded CRM context. |
| `GET /mail/threads/{id}?connection_id=&format=metadata` | Lightweight `{summary}` including `in_inbox` for reminder reconciliation. |
| `GET /mail/messages/{id}/attachments/{attachment}?connection_id=` | `{data,size}`, using base64url data. Not retained by the mail read cache. |
| `GET /mail/drafts?connection_id=&thread_id=` | `{drafts}`. Thread filter is optional. |
| `GET /mail/drafts/{id}` | `{draft}`, including live delivery status. |
| `POST /mail/drafts` | Saves a review draft with `id`, exact `version` (0 for create), `connection_id`, `mode`, `to`, `cc`, `bcc`, `subject`, `body_text`, and optional `thread_id`/`reply_message_id`. Recipients are email-address arrays. |
| `POST /mail/suggest` | `{connection_id,thread_id,reply_message_id,instructions?}` returns `{body_text}` for review. Neither saves nor sends. |
| `POST /mail/send` | `{draft_id,version,operation_id}` returns `{receipt}` with `sent` or `unknown`. No automatic resend after uncertainty. |
| `POST /mail/threads/{id}/modify` | `{connection_id,archive?:Bool,unread?:Bool}`; `archive:false` restores the Inbox label for Undo. |
| `GET /schedule?connection_id=&from=&to=` | `{events,partial,errors,from,to}` across available calendars, with saved briefings/verified attendee links when available. Optional connection/interval filters; `briefings_only=true` reads only imported context. RFC3339 or `YYYY-MM-DD` all-day dates. |

Decision source fields are additive and nullable: `source_connection_id`, `source_thread_id`, and `source_message_id`. Existing SQLite records remain readable after migration. Other workflow responses retain `answered` until their own consumer processes them.

Mail drafts support `compose`, `reply`, `reply_all`, and `forward`. `reply_message_id` is the provider message ID; the server retrieves RFC Message-ID and References for threading. Send reconstructs MIME from reviewed fields, validates headers, and obtains the sender from the selected account. External failures return bounded error codes, not credentials or raw provider response bodies.

## Firehose and diagnostics

The owner-gated Gmail → Jev classifier remains a decision producer (`NANOCODEX_FIREHOSE_DECISIONS_ADMIN_ENABLED=true`, or an exact `NANOCODEX_FIREHOSE_DECISIONS_OWNER_ID`). Hydrated INBOX push snapshots can produce validated personal-reply decisions at confidence at least 0.85, or narrowly classified automated action-review decisions at least 0.95 (security, overdue/failed billing, document signature, or failed service/job). These are review proposals, never sender authentication or authority to reply/pay/sign/retry. Durable per-message receipts deduplicate accepted/negative results. Missing/truncated input and failed/low-confidence classifications do not establish actionable coverage.

`GET /v1/todo/traces?limit=50&before=` pages private trace metadata: policy, outcome/reason, confidence, timing, decision ID, and bounded sender/subject. Bodies, prompts, provider errors, and credentials are not stored. Records are account-scoped, capped at 5,000 and 90 days; the feed includes at most 100 recent non-duplicated diagnostics. This API is not a watch/import heartbeat.

`POST /v1/todo/decision-backtest` accepts up to five caller-supplied labeled fixtures (`id`, `expected: "reply" | "no_reply"`, `from`, `subject`, `body`). It returns classification signals and confusion matrices at documented thresholds, without fetching historical mail, saving fixtures, proposing decisions, or sending. Jev confidence is not measured correctness.

Draft suggestions use Workers AI with bounded prompts/responses, no tools, and AI Gateway request/response collection and caching disabled. They use at most the latest six messages through the selected reply target. Failure does not prevent reading or manual composition.

## Implementation and validation

The queue/filter and attached preparation UI live in [TodoBoardView.swift](../../apple/NanocodexInbox/TodoBoardView.swift), with retained-reader authority gates in [TodoMailSession.swift](../../apple/InboxCore/Sources/InboxCore/TodoMailSession.swift). [todo-crm-context.ts](../../js/managed/src/todo-crm-context.ts) owns exact CRM identity/context resolution; [todo-dispositions.ts](../../js/managed/src/todo-dispositions.ts) owns versioned service snooze state. These source boundaries, not a cache or generated proposal, determine permitted actions.

Run `pnpm --filter nanocodex-managed-service run test:todo-mail` for authenticated HTTP mail and snooze journeys through the Worker/Durable Object transport with synthetic external dependencies. Coverage includes multi-account reads, thread/attachment retrieval, draft edit/reopen/exact-version send, duplicate/ambiguous send handling, owner/origin authorization, CRM identity/context boundaries, and versioned snooze replay/conflict/capacity.

`TodoMailRetainedReadingTests` in `InboxCore` exercise the public URLSession reader/client boundary: relaunch retained reading during failed live checks, query/account isolation, no cached send authority, cache invalidation, and bounded prefetch. `InboxUITests` contain Debug fixture journeys for the mixed queue/filter menu, editable attached AI requests, verified CRM navigation, warm raw-mail reopen, explicit-send locks, task/archive Undo, and linked-row snooze. Use `--demo --todo-ui-fixture --todo-mail-fixture` and `scripts/xcodebuild-guard.sh` on a shared Mac. Fixtures use synthetic mail, not real provider sends.

Keep screenshots, recordings, logs, and result bundles in ignored `output/` or CI artifacts, not tracked source. These are available validation scenarios, not a claim that all passed on a live account. A simulator fixture run does not demonstrate production deployment, full offline operation, Superhuman parity, or a physical-phone installation.
