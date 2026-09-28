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
| Todo | A saved snapshot populates the view before refresh. Draft text, watch hint, and the capture retry operation ID persist. | Saving still requires the service; failed saves retain text for retry. |
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
and verify that the UI identifies its local coverage. Draft a Todo offline, retry
a failed save after relaunch, and verify that its text remains available. Then change accounts and verify that previous account
values are absent, including when an earlier request finishes late.

For original media, separately exercise download, dismiss, offline reopen, and
relaunch; successful initial playback does not establish persistent reuse. Save
screenshots or logs under ignored `output/` or as CI artifacts. This document
describes source behavior and manual verification scenarios, not a record of
completed runtime tests.
