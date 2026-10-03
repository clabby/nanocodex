# Local-first behavior on iPhone and iPad

The app can show previously loaded data while refreshing it. A saved snapshot
may be stale, incomplete, or evicted; it does not establish current authorization
or guarantee that a mutation will work offline. A screen that has never been
loaded may still require a network connection.

## Read coverage

| Surface | Local presentation | Boundary |
| --- | --- | --- |
| Agent list | Saved list can seed account restoration. | Refresh supplies current roster state. |
| Conversation history | Saved history populates the focused conversation before the live tail refresh. Streamed updates are saved on a five-second timer, terminal events, conversation switches, and backgrounding. | Only retained windows are available; older pages may need the network. Snapshot saves require a loaded, contiguous latest window. |
| CRM | Saved responses restore people/company lists, searches, and profile sections, including retained cursor pages. A search without an exact saved response filters the saved directory locally. | Local fallback searches only retained records and may differ from server search. It does not establish that no other matches exist. |
| Connectors | A saved catalog, capability status response, and MCP connection response together populate the overview before refresh. | All three responses must exist and pass the live parsers. Failed refresh retains the displayed overview. |
| Inbox | A saved Todo snapshot and mail account/list/body reads populate the mixed queue and reader before refresh. Capture text, watch hint, and its retry operation ID persist separately. | Only retained, exact-query/page/account reads are available. Saving and mail actions require live checks; an empty queue does not prove complete sync or healthy ingestion. |
| Inbox snooze | Protected, account-scoped presentation journal retains versions and exact pending operation IDs through relaunch. | Acknowledged service dispositions sync to other devices on refresh. Pending changes are labeled; snooze is not Gmail state, task completion, a push reminder, or an offline-send queue. |
| Scheduled jobs | Saved per-agent jobs can seed the list. | Unread agents and missing snapshots require network reads. |
| Attachment previews | Account-scoped HTTP caching supports immutable image previews. | HTTP cache retention and freshness apply; this is separate from retaining originals. |
| Downloaded originals, videos, and private outputs | Previously downloaded originals can reopen from an account-scoped disk cache, including after relaunch. Preview/playback receives a disposable copy. | A 256 MiB per-account budget evicts older files. Missing, oversized, or unavailable originals still require a download. |

These behaviors are implemented in [InboxModel.swift](NanocodexInbox/InboxModel.swift),
[CRMView.swift](NanocodexInbox/CRMView.swift),
[ConnectorsView.swift](NanocodexInbox/ConnectorsView.swift), and
[ManagedClient.swift](InboxCore/Sources/InboxCore/ManagedClient.swift).
Connector snapshots use the validators in
[Connectors.swift](InboxCore/Sources/InboxCore/Connectors.swift).

## Account and refresh boundaries

Cached server responses are account-scoped. Model reads check account generation
before publishing asynchronous results. CRM selection includes the account
generation, and connector content is recreated when that generation changes.
Explicit sign-out clears cached responses. Keeping already displayed data during
a failed refresh is not permission to show it in another account.

Read caches are separate from persisted drafts and the existing message queue.
Do not assume that connector, CRM, or other service mutations are queued merely
because their screens can display saved data. Todo capture retries reuse the saved
operation ID while the text and watch hint remain the same; retaining this ID
does not enqueue a background save.

## Retained Inbox mail and presentation state

The default **Inbox** mixes loaded mail, upcoming events, decisions, captures,
review drafts, and recent agent work. Mail/Snoozed/Drafts/Sent/All mail are optional
menu filters, not permanent split tabs. The mail reader restores a saved body
before network checks and labels saved reading while it refreshes. Successful
reads remain visible during partial outages. Low-priority lookahead prefetches
only the next three loaded conversations, at most two body requests concurrently;
it does not download the whole mailbox. Lists use bounded pages and explicit
Load more. Routine Calendar refresh reads imported briefings; pull-to-refresh
additionally reads live calendars. Search and unloaded conversations can still
require the network.

The retained read cache admits the mail account roster and exact connection,
query/page, and thread GETs. It excludes mail draft/status reads, individual
decision approval reads, and attachment bytes. Protected mail draft recovery is
separate and preserves edits and uncertain-send locks, not authorization.
Reply/compose initiation, suggestions, and Send require successful live account,
conversation (where applicable), and draft checks; prepared approval also checks
current matching decision context. Reading a saved body does not unlock them.
Acknowledged archive/Undo/send invalidate mail list/body snapshots and fence
older reads; draft autosaves do not evict retained bodies. Read snapshots share a
64 MiB/512-file account-scope retention budget, with a 32 MiB per-response
admission bound; retention is not guaranteed.

Snooze/Bring back uses a protected atomic journal before each service dispatch.
It retains the exact operation UUID/version and retries that operation after an
outage rather than creating another change. Local pending sync and persistence
or restoration failures are visible. Invalid/stale/unavailable targets reconcile
against live service state and require review. Other devices see acknowledged
presentation state on refresh; no provider labels are changed. Linked mail
and message decisions share one thread reminder. Retained summaries and remote
source-qualified mail disposition keys, including due reminders outside the
first loaded page, rotate through at most five metadata reads per refresh,
oldest-check first with a 60-second recheck interval. Larger reminder sets can
take several refreshes to appear. Archived/removed mail reconciles out; errors
remain visible and account/client/cancellation fences reject late results.
Metadata does not grant send authority. Already loaded due rows return on the
next visible refresh, not a push notification. There are at most 1,000 pending device
commands, a 2 MiB journal, and 1,000 distinct service keys including expired/cleared
versions. New keys at service capacity are rejected; coverage is explicit.

Owner-private CRM links use unique exact saved email/alias matches, never names,
domains, or generated prose. Retained profile/context is bounded and may be
stale; a link is not sender authentication or approval authority. Editable AI
requests attach an item's bounded reference snapshot and authorize preparation
only. Raw-mail snippets are not universal automatic generative briefings. This
is retained reading and presentation sync, not true offline sending or full
Superhuman parity. See the [Inbox contract](../docs/integrations/todo-inbox.md)
and [TodoMailSession.swift](InboxCore/Sources/InboxCore/TodoMailSession.swift).

## Downloaded-file lifetime

`ManagedClient.downloadOutput`, `downloadAttachment`, and `downloadVideo` perform
network downloads and return temporary URLs after validating their responses.
`InboxModel` first checks the downloaded-file cache and discards a result if the
account changes while it is restoring or downloading.
Private output downloads also enforce a size bound and preserve the filename in
an isolated temporary directory.

[ChatMediaPreview.swift](NanocodexUI/Sources/NanocodexUI/ChatMediaPreview.swift)
and output/video consumers in [InboxView.swift](NanocodexInbox/InboxView.swift)
remove these disposable files when their presentation ends.
[DownloadSnapshotCache.swift](InboxCore/Sources/InboxCore/DownloadSnapshotCache.swift)
keeps separate canonical copies in Application Support, excluded from backups.
Scope and resource keys are hashed for directory and file names; original paths
and keys are not written as metadata. Each restore copies the original to a
`NanocodexOutput-Offline-` temporary directory, preserving the requested filename.
Deleting that lease leaves the cached original available.

The cache accepts regular, non-symbolic files up to 256 MiB and evicts the oldest
saved files by modification time to keep each account within 256 MiB. Writes use
an atomic rename after copying; storage failures leave the caller's download
usable. Explicit clear deletes the account directory and permanently disables
that actor instance, so a late save through it cannot repopulate the directory.
Callers validate server responses before saving. An output resource key represents
the saved version: overwriting a remote file at the same path does not refresh
an already cached copy automatically.

Locally staged attachment originals in
[AttachmentStore](InboxCore/Sources/InboxCore/MessageAttachment.swift) have a
separate lifecycle and are not a cache of every downloaded attachment.

## Checking offline behavior

Use a synthetic account to load the relevant list, conversation, CRM query and
profile, and connector overview while online. Relaunch offline and inspect which
previously loaded values appear. Refresh while offline and verify that existing
values remain visible. Try a new CRM search against previously retained records
and verify that the UI identifies its local coverage. Draft a capture offline, retry
a failed save after relaunch, and verify that its text remains available. Load a
mail query and conversation online, relaunch offline, and verify saved reading
and errors without enabling reply/Send. Test a different query/account and an
unloaded body rather than assuming whole-mailbox coverage. Snooze while the
service is unavailable, relaunch, inspect pending sync, then reconnect and verify
the same operation is acknowledged and another device observes it on refresh.
Then change accounts and verify that previous account
values are absent, including when an earlier request finishes late.

For original media, separately exercise download, dismiss, offline reopen, and
relaunch; successful initial playback does not establish persistent reuse. Save
screenshots or logs under ignored `output/` or as CI artifacts. This document
describes source behavior and manual verification scenarios, not a record of
completed runtime tests, deployment, or a physical-phone installation.
