# PR673 / PR692 integration review — 2026-09-30

## Scope and branch isolation

Pinned integration base `168ac402ecdcffafe3748111d8e6834b8174f689` was merged separately into both audit branches. Original PR673 head: `e1090c47cfffe76f81fe1998e9304d0ceacaa35a`; original PR692 head: `d005b404d5947160ce76a26dec249f9108f007c6`. Base merge heads were respectively `a15f03cfefba59f9854723105a6e5e05e8e58c86` and `328e204fda92a451f8b481f0a21629e35862f303`. No other unmerged PR implementation was copied into either branch. Only root may push/merge/deploy. This report is identical in both worktrees to avoid an artificial report-file merge conflict.

## PR673: native personal apps

Reviewed `NanocodexApps` parser/runtime/SwiftUI renderer, generated-app native screen/store, prompt-apps HTTP/D1/tool routes and durable agent journal. The runtime parses actual bounded Swift source and renders native SwiftUI controls, not HTML/JS/WebKit. The backend accepts only `swift-v1`; unsupported imports/runtimes are rejected. Persisted keys and unknown state survive source-driven writes; prompt edits and restore operate independently of data revisions. Agent access is action-only, not rendering; request/create/turn IDs and original input persist before remote admission. Lost receipts and failed local actions reconcile existing work; terminal receipts are retired only after native action commit, and explicit new attempts warn about prior effects.

Executed on Apple Swift 6.3.3 / macOS arm64, Node 26.8.1:

- `swift build -j 3 --package-path apple/NanocodexApps --product native-app-journey`: PASS (`native-build.log`).
- Production executable `--self-test --screenshot .../native-selftest.png`: PASS. Covers binding/actions, records/functions/loops, JSON restart, synthetic async agent, bounds, rollback, queued saves, late response invalidation and recovery (`native-selftest.log`). Inspected screenshot: actual NSHostingView native text field/buttons, not a web surface; it is a runtime ledger, not an iPhone UI approval.
- `Journeys/run.py` against that executable: **22/22 PASS**, including log/undo/reopen, invalid input, user-chosen goal, agent-response editing without accidental persistence, stable packing state and 1,000-record histories (`holdouts.log`, `holdouts/`).
- `swift test ... --filter GeneratedAppAgentJournalTests`: **3/3 PASS**, no skips. Lost create/admission replies reuse IDs/input; restart after local failure makes zero network calls for terminal recovery; corruption, failed atomic writes, unexpected file loss and capacity fail closed (`agent-journal.log`).
- Shipped account proxy suite: **21/21 PASS** (`account-apps-proxy.log`).
- All three shipped prompt-apps HTTP/D1 scenarios: **3/3 PASS** using a review-only narrow Worker fixture with synthetic authentication and the shipped proxy + `routeAppsRequest`; real workerd/D1 and all migrations (`apps-focused-routes.log`, `apps-router-worker.ts`). Verifies direct authorization/origin, account isolation, create/edit/restore, state CAS races, delete, pagination, size/shape limits, and rejection of legacy/mismatched runtimes. Original full-index Vitest config was attempted but could not import absent locally generated `js/pkg-web/nanocodex_bg.wasm`; that broad worker suite is NOT represented as passed (`apps-routes.log`). No replacement fake WASM was made.
- `typos apple/NanocodexInbox/TodoBoardView.swift`: PASS. Master/pinned base already contains the exact SF Symbols `mappin` dictionary exception in `typos.toml`; merging base supplies it. Do not change the valid symbol spelling.

No additional production PR673 defect was demonstrated in these journeys. CI's prior mobile timeline/media exit65 is NOT diagnosed or claimed fixed here; root owns joint Simulator build/UI and drawer/timeline/media captures.

## PR692: durable meeting library

Reviewed iOS capture checkpoints/partial recovery, library/cache/outbox, native notes/transcript views, desktop editor, account proxy and meeting-library routes. Saving uses the meeting outbox and bounded stateless enhancement, not agent/chat creation. Direct-account scope, org/team isolation, immutable upload attempts and CAS bases, conflict preservation, metadata/detail refresh, summary receipts/leases/quotas, and permanent server/local deletion tombstones were exercised without microphone or real inference.

Executed:

- `node --test test/meeting-library-journey.test.mjs`: **1/1 PASS**, real HTTP edge -> shipped account proxy -> shipped meeting router -> persistent D1, with only trusted auth and external inference synthetic (`meeting-http.log`; `output/meeting-library-journey/http-trace.json`). Includes restart, summary/edit races, lease recovery, full-source rolling summaries, storage/summary quotas, body/media boundaries, account/org/team isolation, atomic If-Match, lost/replayed revisions and permanent deletion.
- `swift test ... --filter MeetingLibraryJourneyTests`, with local production-router fixture and journey directory: **4/4 PASS, zero skips** (`meeting-swift-http.log`, `swift-http-journey/` SQLite evidence). Includes durable partial capture/reopen, actual transport isolation, immutable lost-response retry then coalescing, offline notes-only recovery, second-device detail/recap, durable two-copy conflicts and explicit resolution, deletion/tombstones, invalid uploads not starving other UUIDs, concurrent saves drained without refresh, and stale editor after background refresh. An earlier environmentless run skipped all four; only the configured run counts as verification.
- Shipped account proxy suite: **20/20 PASS** (`account-meeting-proxy.log`).
- Migration coexistence SQLite execution: PASS in both lexical and prompt-first order (`migration-coexistence.log`).

Concrete fix: macOS `MacMeetingLibrary` kept drafts and immutable save/CAS receipts only in memory, losing uncertain work across process restart, and retained a definitively invalid attempted payload forever. Added bounded fail-closed account-scoped `MacMeetingSaveJournal`, durable draft/receipt commit BEFORE HTTP, exact retry after restart, retention of later typing through acknowledgement, validation-rejection release without discarding notes, and protected0700 journal directory. Account activation occurs only from accepted runtime state, including unchanged reconnect responses; begin requires an active scope, and credential/account transitions block meeting requests. Changed credentials are installed before accepted state activates the restored journal.

- `swift test ... --filter MacMeetingSaveJournalTests`: **8/8 PASS**, zero skips (`mac-journal.log`). Covers lost-response restart and exact CAS, typing during request including reversion to baseline, acknowledged cleanup, sameUUID account isolation, corrected rejected payload, count/byte bounds without eviction, failed writes and corrupt journal/empty scope.
- Extracted production `MacMeetingLibrary` class `swiftc -typecheck` against built InboxCore/GRDBSQLite: PASS (`mac-library-typecheck.log`). Full macOS AppModel/MeetingsView syntax parse: PASS (`mac-meetings-syntax.log`). This is not a full desktop Xcode/UI build.
- `git diff --check`: PASS.

## Migration numbering: no demonstrated collision

Base migrations end at `0010_crm_graph.sql` and already contain two distinct `0008` filenames. PR673 adds `0011_prompt_apps.sql`; PR692 adds `0011_meeting_library.sql` and dependent `0012_meeting_summary_recovery.sql`. Inspected installed Wrangler implementation: applied migrations are identified by their **full filename**, and matching numeric prefixes are ordered by filename. These0011 files create disjoint tables; SQLite application succeeds with either0011 ordering, with0012 after meeting schema. No files were renamed, and no applied/deployment history was guessed. Root's eventual deployment must apply both exact0011 filenames and0012; live D1 history has not been queried.

## Ready conditions and honest gates

Branches are ready for root's separate local integration, subject to the root-owned combined iOS Xcode/Simulator build/UI and post-push CI on final heads. Preserve both branches' original changes, the base merges, the macOS durability fix and exact migration names. Root must resolve/verify shared iOS project/InboxModel/InboxView/package-script integration rather than treating separate branch tests as combined proof. The previous mobile UI exit65 remains a root gate. Full-index managed Vitest awaits generated agent WASM; the focused shipped app routes were actually exercised instead.

No live agent generation, email, microphone recording, real account writes, signing credentials, GitHub writes, push, merge or deployment occurred. Physical iPhone locked recording, microphone/Speech permission/interruption/audio-route/CallKit/Bluetooth/notification behavior and real inference availability were not tested; Simulator and synthetic fixtures cannot certify these physical-device gates. Full desktop Xcode/UI execution, multi-process concurrent desktop editor writers and production deployment state are outside this bounded review.
