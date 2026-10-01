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
    /// Presentation-only snapshots. Fresh draft/send checks still belong to the reader.
    @Published private(set) var showingCachedMail = false
    var mailReadStatus: String? {
        showingCachedMail ? (loading ? "Saved mail · refreshing…" : "Retained mail · refresh incomplete") : nil
    }
    @Published var error: String?
    @Published var scheduleError: String?
    @Published var busy: Set<String> = []
    private var prefetchTask: Task<Void, Never>?
    private var prefetchKey = ""
    private var clientScope = ""
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
        prefetchTask?.cancel(); prefetchTask = nil; prefetchKey = ""
        clientScope = ""; showingCachedMail = false
        revision &+= 1; lifetime &+= 1
        accounts = []; threads = []; events = []; drafts = []; pages = [:]
        loading = false; loaded = false; scheduleLoading = false; scheduleLoaded = false; error = nil; scheduleError = nil; busy = []
        selection = ""; lastLoadedSelection = ""
    }

    private struct AccountRead: Sendable {
        let connectionID: String
        let page: TodoMailPage?
        let drafts: [TodoMailDraft]?
        let error: String?
    }
    nonisolated private static func readDrafts(client: ManagedClient, accounts: [TodoMailAccount]) async -> [AccountRead] {
        await withTaskGroup(of: AccountRead.self, returning: [AccountRead].self) { group in
            var next = 0
            var result: [AccountRead] = []
            func admit(_ connection: TodoMailAccount) {
                group.addTask {
                    do {
                        return AccountRead(connectionID: connection.id, page: nil,
                                           drafts: try await client.todoMailDrafts(connectionID: connection.id), error: nil)
                    } catch {
                        return AccountRead(connectionID: connection.id, page: nil, drafts: nil,
                                           error: "Mail drafts: " + error.localizedDescription)
                    }
                }
            }
            while next < min(3, accounts.count) { admit(accounts[next]); next += 1 }
            while let value = await group.next() {
                if Task.isCancelled { group.cancelAll(); break }
                result.append(value)
                if next < accounts.count { admit(accounts[next]); next += 1 }
            }
            return result
        }
    }
    private func sortThreads() {
        var seen = Set<String>()
        threads = threads.filter { seen.insert($0.connectionID + ":" + $0.id).inserted }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Low-priority next-three lookahead; a reader still refreshes server state.
    /// Pass the opened row to move the window ahead without downloading a mailbox.
    func prefetchMail(client: ManagedClient?, around thread: TodoMailThreadSummary? = nil) {
        guard let client, client.todoMailStorageScope == clientScope else { return }
        let start = thread.flatMap { opened in threads.firstIndex { $0.id == opened.id && $0.connectionID == opened.connectionID } }.map { $0 + 1 } ?? 0
        let neighbors = Array(threads.dropFirst(start).prefix(3))
        let key = neighbors.map { $0.connectionID + ":" + $0.id }.joined(separator: "\n")
        guard key != prefetchKey else { return }
        prefetchTask?.cancel(); prefetchTask = nil; prefetchKey = key
        guard !neighbors.isEmpty else { return }
        prefetchTask = Task(priority: .utility) { await client.prefetchTodoMailThreads(neighbors) }
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
        if !clientScope.isEmpty && clientScope != client.todoMailStorageScope { reset() }
        clientScope = client.todoMailStorageScope
        let key = account + "\n" + query
        if loading && selection == key { return }
        prefetchTask?.cancel(); prefetchTask = nil; prefetchKey = ""
        revision &+= 1
        let ticket = revision
        let paginate = more && key == lastLoadedSelection
        selection = key; loading = true; error = nil
        if key != lastLoadedSelection { threads = []; pages = [:]; drafts = []; showingCachedMail = false }
        defer { if revision == ticket { loading = false } }

        // Restore presentation before any network request. Nothing here admits
        // draft edits, provider mutations or approval from retained data.
        if accounts.isEmpty, let saved = await client.cachedTodoMailAccounts() {
            guard revision == ticket, !Task.isCancelled else { return }
            accounts = saved
        }
        if !paginate && threads.isEmpty {
            let retainedAccounts = accounts.filter { account.isEmpty || $0.id == account }
            await withTaskGroup(of: (String, TodoMailPage?).self) { group in
                for connection in retainedAccounts {
                    group.addTask { (connection.id, await client.cachedTodoMailThreads(connectionID: connection.id, query: query)) }
                }
                for await (id, page) in group {
                    guard revision == ticket, !Task.isCancelled else { group.cancelAll(); return }
                    if let page {
                        threads.append(contentsOf: page.threads); pages[id] = page.nextPageToken
                        sortThreads(); loaded = true; lastLoadedSelection = key; showingCachedMail = true
                    }
                }
            }
            guard revision == ticket, !Task.isCancelled else { return }
            prefetchMail(client: client)
        }

        var available = accounts
        do {
            available = try await client.todoMailAccounts()
            guard revision == ticket, !Task.isCancelled else { return }
            accounts = available
            let ids = Set(available.filter { account.isEmpty || $0.id == account }.map(\.id))
            threads.removeAll { !ids.contains($0.connectionID) }
            drafts.removeAll { !ids.contains($0.connectionID) }
            pages = pages.filter { ids.contains($0.key) }
        } catch {
            guard revision == ticket, !Task.isCancelled else { return }
            self.error = "Mail accounts: " + error.localizedDescription
            // A roster outage doesn't erase retained mail or stop refreshing
            // accounts already known to this credential scope.
        }
        let selected = available.filter { (account.isEmpty || $0.id == account) && (!paginate || pages[$0.id] != nil) }
        let cursors = pages
        // Draft latency must not delay visible list results or body lookahead.
        async let draftResults = Self.readDrafts(client: client, accounts: paginate ? [] : selected)
        await withTaskGroup(of: AccountRead.self) { group in
            var next = 0
            func admit(_ connection: TodoMailAccount) {
                group.addTask {
                    do {
                        let page = try await client.todoMailThreads(connectionID: connection.id, query: query, pageToken: paginate ? cursors[connection.id] : nil)
                        return AccountRead(connectionID: connection.id, page: page, drafts: nil, error: nil)
                    } catch {
                        return AccountRead(connectionID: connection.id, page: nil, drafts: nil, error: "Mail: " + error.localizedDescription)
                    }
                }
            }
            while next < min(3, selected.count) { admit(selected[next]); next += 1 }
            while let result = await group.next() {
                guard revision == ticket, !Task.isCancelled else { group.cancelAll(); return }
                if let page = result.page {
                    if !paginate { threads.removeAll { $0.connectionID == result.connectionID } }
                    threads.append(contentsOf: page.threads); pages[result.connectionID] = page.nextPageToken
                    sortThreads(); loaded = true; lastLoadedSelection = key
                }
                if let message = result.error { error = message }
                if next < selected.count { admit(selected[next]); next += 1 }
            }
        }
        guard revision == ticket, !Task.isCancelled else { return }
        loaded = true; lastLoadedSelection = key
        prefetchMail(client: client)
        for result in await draftResults {
            guard revision == ticket, !Task.isCancelled else { return }
            if let saved = result.drafts {
                drafts.removeAll { $0.connectionID == result.connectionID }
                drafts.append(contentsOf: saved.filter { $0.status != "sent" })
            }
            if let message = result.error { error = message }
        }
        guard revision == ticket, !Task.isCancelled else { return }
        showingCachedMail = error != nil && !threads.isEmpty
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
            prefetchTask?.cancel(); prefetchTask = nil; prefetchKey = ""
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
