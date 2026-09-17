# Project chat and persistent task threads

Reference: [0xDesigner’s project chat](https://x.com/0xDesigner/status/2100679849249771839), [original walkthrough](https://x.com/0xDesigner/status/2092635269081989572), and [Boris Cherny’s quoted workflow](https://x.com/bcherny/status/2100669598995816511).

The mobile shell uses a project sidebar, a persistent master chat, compact project header, blue user bubbles, unboxed replies, and one composer. A live-task pill opens a native Tasks/Agents sheet. Tasks are durable child threads, with status and drill-down to their messages. Links beside the originating message open delegated work. Back, screens, captured context, connectors and scheduled jobs remain in the header menu.

New project creates a named home backed by a managed agent. Existing conversations remain project homes. Rename changes the navigation name; names persist locally per account. Server-owned parent/root/turn metadata groups spawned agents under their actual master across devices. Selecting a project returns to its master chat. Selecting an agent opens that member conversation. Sheets retain the master conversation and its draft; task detail subscribes to bounded background history while visible.

## Simulator recording

[Watch the iPhone simulator walkthrough](media/project-threads-ios.mp4) (iPhone 16 Pro, iOS 18.2).

![Project chat, tasks, task detail, agents and sidebar](media/project-threads-ios.gif)

The clip is trimmed from the passing XCTest journey. Static captures: [chat](media/project-chat.png), [tasks](media/project-tasks-sheet.png), [task detail](media/project-task-detail.png), [agents](media/project-agents-sheet.png), [sidebar](media/project-sidebar.png).

## Persistent delegation

- `spawn_project_thread({id, title, input})` starts a separate durable managed agent and admits its initial task. The child inherits the parent's configuration and invoking turn's capabilities. Connect grants cannot use this capability; disabled delegation remains disabled.
- A stable caller-selected ID produces the same child and turn on retry. A durable account-owned relationship rejects changed input or attempts to reparent a thread. Retrying after an ambiguous admission reuses the existing turn.
- `send_project_thread({agent_id, id, input})` admits a follow-up in a directly delegated child. Stable IDs deduplicate retries and changed input conflicts. `list_project_threads` returns the latest tracked task status; `read_project_thread` accepts an optional exact `turn_id`.
- A parent-owned durable outbox retries ambiguous admissions and checks task outcomes using alarms (five seconds while running, one minute after transport failure). Terminal outcomes enqueue one idempotent internal completion turn in the parent, including after eviction. The parent reads the actual result and continues within the original task scope. This uses no model calls for polling.
- Pending outcomes are bounded to 128. Delivery retains the invoking authorization and retires on authorization-epoch changes. Export is fenced while outcomes are pending.
- Child context is explicit in `input`; no hidden transcript cloning occurs. Nested delegation stays in the same project. A project is bounded to 128 undeleted child threads.

The master handles small requests directly, uses ordinary subagents for bounded helper work, and creates persistent threads for independently progressing work that may be revisited. Follow-ups reuse the existing thread. Parallel coding threads are instructed to use isolated worktrees/branches. Personal memory already covers user preferences; project names remain device-local.

Automatic return applies to turns delegated with the project tools, including follow-ups. Messages sent directly inside a child chat are not automatically reported back to its parent. Completion events are explicitly labelled as internal task outcomes, never new human instructions. The coordinator’s final wording and delegation decisions remain model behavior.

The task sheet describes its loaded-history scope. Unknown historical outcomes are labelled History, never assumed successful. Task projections are cached across composer edits. Generated outputs remain in the full conversation; the detail sheet displays task messages.

## Validation

The full InboxCore suite passes (186 tests, five expected skips); five focused project tests cover server lineage parsing, real task identities/statuses, partial history, and local-to-server ID migration. Backend tests cover durable project membership, nested roots, account boundaries, changed-input conflicts, retry after failed admission, and rejection of tool authority overrides. Type checking and a Worker-only Wrangler dry run pass. The broader CI also has failures in unchanged Rust code (redundant clone, Windows screen cfg, voice timing). The unrelated connector-provider catalog test fails because its expected list omits Link; the same failure was reproduced against unchanged HEAD.

Seven simulator tests pass (three project journeys and four drawer/menu/back-navigation regressions). The new tests verify: Tasks/Agents navigation retains the draft, and a named project survives app relaunch. The simulator journey uses explicitly opted-in Debug fixtures with representative master/child conversations. It verifies navigation and draft preservation; it does not claim a live model chose to delegate. Signed-device delivery and production deployment are not part of this PR.

Runtime integration checks exercise actual managed child admission, replay after lost acknowledgment, parent eviction, success/failure/cancellation wakeups, duplicate-result deduplication, retained authority, revocation, and the pending-work bound. Model execution is held at the durable retry boundary in these tests; no production model or deployment is used.
