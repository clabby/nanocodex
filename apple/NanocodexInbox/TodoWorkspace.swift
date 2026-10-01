import SwiftUI
import InboxCore

/// One retained projection for the bottom-left tab. Mail and schedule failures do
/// not erase the decision feed, and stale searches cannot replace newer results.
@MainActor
final class TodoWorkspace: ObservableObject {
    @Published var accounts: [TodoMailAccount] = []
    @Published var threads: [TodoMailThreadSummary] = []
    @Published var events: [TodoScheduleEvent] = []
    @Published var drafts: [TodoMailDraft] = []
    @Published var loading = false
    @Published var loaded = false
    @Published var error: String?
    @Published var scheduleError: String?
    @Published var busy: Set<String> = []
    private var pages: [String: String] = [:]
    private var revision = 0
    private var lifetime = 0
    private var scheduleLoading = false
    private var scheduleLoaded = false
    private var selection = ""
    var hasMore: Bool { !pages.isEmpty }
    func canLoadMore(account: String, query: String) -> Bool {
        !loading && !pages.isEmpty && lastLoadedSelection == account + "\n" + query
    }

    func reset() {
        revision &+= 1; lifetime &+= 1
        accounts = []; threads = []; events = []; drafts = []; pages = [:]
        loading = false; loaded = false; scheduleLoading = false; scheduleLoaded = false; error = nil; scheduleError = nil; busy = []
        selection = ""; lastLoadedSelection = ""
    }

    func refresh(client: ManagedClient?, account: String, query: String, demo: Bool, more: Bool = false) async {
        if demo {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--todo-mail-fixture"), !loaded { loadFixture() }
            #endif
            loaded = true
            return
        }
        guard let client else { return }
        let key = account + "\n" + query
        if loading && selection == key { return }
        revision &+= 1
        let ticket = revision
        let paginate = more && key == lastLoadedSelection
        selection = key; loading = true; error = nil
        if key != lastLoadedSelection { threads = []; pages = [:]; drafts = [] }
        defer { if revision == ticket { loading = false } }
        do {
            let available = try await client.todoMailAccounts()
            guard revision == ticket, !Task.isCancelled else { return }
            accounts = available
            let selected = available.filter { account.isEmpty || $0.id == account }
            var nextPages = paginate ? pages : [:]
            var received: [TodoMailThreadSummary] = paginate ? threads : []
            var saved: [TodoMailDraft] = paginate ? drafts : []
            // Each account has its own page cursor. A partial outage preserves
            // successful accounts and presents the failure inline.
            for connection in selected {
                if paginate && pages[connection.id] == nil { continue }
                do {
                    let page = try await client.todoMailThreads(connectionID: connection.id, query: query, pageToken: paginate ? pages[connection.id] : nil)
                    guard revision == ticket, !Task.isCancelled else { return }
                    received.append(contentsOf: page.threads)
                    nextPages[connection.id] = page.nextPageToken
                    if !paginate { saved.append(contentsOf: try await client.todoMailDrafts(connectionID: connection.id)) }
                } catch {
                    guard revision == ticket, !Task.isCancelled else { return }
                    self.error = "Mail: " + error.localizedDescription
                }
            }
            guard revision == ticket, !Task.isCancelled else { return }
            var seen = Set<String>()
            threads = received.filter { seen.insert($0.connectionID + ":" + $0.id).inserted }
                .sorted { $0.updatedAt > $1.updatedAt }
            pages = nextPages
            drafts = saved.filter { $0.status != "sent" }
            loaded = true; lastLoadedSelection = key
        } catch {
            guard revision == ticket, !Task.isCancelled else { return }
            self.error = "Mail: " + error.localizedDescription
        }
    }
    private var lastLoadedSelection = ""

    func refreshSchedule(client: ManagedClient?, demo: Bool, liveRefresh: Bool = false) async {
        if demo {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--todo-mail-fixture"), !loaded { loadFixture(); loaded = true }
            #endif
            return
        }
        guard let client, !scheduleLoading else { return }
        let ticket = lifetime
        scheduleLoading = true
        defer { if lifetime == ticket { scheduleLoading = false } }
        let path = "/v1/todo/schedule" + (liveRefresh ? "" : "?briefings_only=true")
        if !scheduleLoaded, let saved = await client.cachedJSON(path: path) {
            let restored = await Task.detached { try? TodoSchedule(saved) }.value
            guard lifetime == ticket, !Task.isCancelled else { return }
            if let restored { events = restored.events; scheduleLoaded = true }
        }
        do {
            let result = try await client.todoSchedule(briefingsOnly: !liveRefresh)
            guard lifetime == ticket, !Task.isCancelled else { return }
            events = result.events; scheduleLoaded = true
            scheduleError = liveRefresh ? (result.partial ? "Calendar coverage is partial." : nil) : "Imported calendar context only · pull to refresh live calendars."
        } catch {
            guard lifetime == ticket, !Task.isCancelled else { return }
            scheduleError = "Calendar: " + error.localizedDescription
        }
    }

    func archive(_ thread: TodoMailThreadSummary, client: ManagedClient?, demo: Bool, undo: Bool = false) async -> Bool {
        let key = thread.connectionID + ":" + thread.id
        guard !busy.contains(key) else { return false }
        let ticket = lifetime
        busy.insert(key)
        defer { if lifetime == ticket { busy.remove(key) } }
        do {
            if !demo {
                guard let client else { return false }
                try await client.modifyTodoMailThread(connectionID: thread.connectionID, threadID: thread.id,
                                                     archive: !undo)
            }
            guard lifetime == ticket else { return false }
            // Fence list reads begun before this provider mutation.
            let interruptedLoad = loading
            revision &+= 1; loading = false
            let parts = selection.components(separatedBy: "\n")
            let selectedAccount = parts.first ?? "", selectedQuery = parts.dropFirst().joined(separator: "\n")
            let matchingAccount = selectedAccount.isEmpty || selectedAccount == thread.connectionID
            let matchingInbox = selectedQuery.isEmpty || selectedQuery == "in:inbox" || (selectedQuery == "in:inbox is:unread" && thread.isUnread)
            if undo {
                if matchingAccount && matchingInbox && !threads.contains(where: { $0.id == thread.id && $0.connectionID == thread.connectionID }) { threads.insert(thread, at: 0) }
            } else { threads.removeAll { $0.id == thread.id && $0.connectionID == thread.connectionID } }
            if interruptedLoad {
                Task {
                    guard self.lifetime == ticket else { return }
                    await self.refresh(client: client, account: selectedAccount, query: selectedQuery, demo: demo)
                }
            }
            return true
        } catch { if lifetime == ticket { self.error = error.localizedDescription }; return false }
    }

    #if DEBUG
    private func loadFixture() {
        accounts = [try! TodoMailAccount(.object(["connection_id": .string("fixture-mail"), "label": .string("Alex Morgan"), "email": .string("alex@example.com")]))]
        threads = [try! TodoMailThreadSummary(.object([
            "id": .string("fixture-thread"), "connection_id": .string("fixture-mail"),
            "subject": .string("A quick look at the launch plan"), "from": .string("Maya Chen"),
            "snippet": .string("Thursday at 10 works for Jordan too. Does that work for you?"),
            "date": .string(Date.now.addingTimeInterval(-1800).ISO8601Format()),
            "unread": .bool(true), "message_count": .number(2), "labels": .array([.string("INBOX"), .string("UNREAD")]),
        ])), try! TodoMailThreadSummary(.object([
            "id": .string("fixture-budget"), "connection_id": .string("fixture-mail"),
            "subject": .string("September notes"), "from": .string("Jordan Lee"),
            "snippet": .string("The updated notes are ready for your review."),
            "date": .string(Date.now.addingTimeInterval(-7200).ISO8601Format()),
            "unread": .bool(false), "message_count": .number(1), "labels": .array([.string("INBOX")]),
        ]))]
        events = [try! TodoScheduleEvent(.object([
            "id": .string("fixture-planning"), "connection_id": .string("fixture-mail"), "calendar_id": .string("primary"),
            "title": .string("Launch planning"), "start": .string(Date.now.addingTimeInterval(2400).ISO8601Format()),
            "end": .string(Date.now.addingTimeInterval(4200).ISO8601Format()), "all_day": .bool(false),
            "briefing_status": .string("ready"), "briefing": .string("Discuss launch date and owners. Invitees are expected, not confirmed attendees."),
            "location": .string("Studio · Room 2"), "description": .string("Review the launch date, owners, and first round of invitations."),
        ]))]
    }
    #endif
}
