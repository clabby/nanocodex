import SwiftUI
import InboxCore
import NanocodexUI
import os

private enum TodoDestination: Identifiable {
    case decision(TodoDecision), mail(String, String, String? = nil), draft(TodoMailDraft), compose, event(TodoScheduleEvent), capture(TodoCapture)
    var id: String {
        switch self {
        case .decision(let item): return "decision:" + item.id
        case .mail(let account, let thread, let message): return "mail:" + account + ":" + thread + ":" + (message ?? "")
        case .draft(let item): return "draft:" + item.id
        case .compose: return "compose"
        case .event(let item): return "event:" + item.id
        case .capture(let item): return "capture:" + item.id
        }
    }
}

private enum TodoQueueRow: Identifiable {
    case decision(TodoDecision), mail(TodoMailThreadSummary), event(TodoScheduleEvent), capture(TodoCapture), draft(TodoMailDraft), agent(AgentCard)
    var id: String {
        switch self {
        case .decision(let item): return "decision:" + item.id
        case .mail(let item): return "mail:" + item.connectionID + ":" + item.id
        case .event(let item): return "event:" + item.id
        case .capture(let item): return "capture:" + item.id
        case .draft(let item): return "draft:" + item.id
        case .agent(let item): return "agent:" + item.id
        }
    }
    var snoozeID: String {
        if case .decision(let item) = self, let account = item.sourceConnectionID, let thread = item.sourceThreadID { return "mail:" + account + ":" + thread }
        if case .event(let item) = self {
            let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
            return "event:" + item.connectionID + ":" + (item.calendarID.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") + ":" + item.eventID
        }
        return id
    }
    var rank: Int {
        switch self {
        case .event(let event): return event.startAt < Date.now.addingTimeInterval(3600) ? 0 : 4
        case .decision(let item): return item.isPreparedForReview || [.blocked, .failed].contains(item.preparationState) ? 1 : 3
        case .draft: return 2
        case .capture(let item): return [.blocked, .failed].contains(item.preparationState) ? 1 : item.preparationState == .ready ? 2 : 3
        case .mail(let item): return item.isUnread ? 2 : 5
        case .agent(let item): return item.sidebarStatus == "Failed" ? 1 : item.isRunningInSidebar ? 4 : 2
        }
    }
    var date: Date {
        switch self {
        case .event(let item): return item.startAt
        case .mail(let item): return item.updatedAt
        case .capture(let item): return ISO8601DateFormatter().date(from: item.createdAt) ?? .distantPast
        case .agent(let item): return Date(timeIntervalSince1970: item.updatedAt / 1000)
        default: return .distantPast
        }
    }
    var searchable: String {
        switch self {
        case .event(let item): return item.title + " " + item.location
        case .decision(let item): return item.title + " " + item.context
        case .capture(let item): return item.body
        case .mail(let item): return item.sender + " " + item.subject + " " + item.snippet
        case .draft(let item): return item.subject + " " + item.to.joined(separator: " ") + " " + item.bodyText
        case .agent(let item): return item.title + " " + item.preview + " " + item.sidebarLastUserPrompt
        }
    }
}

/// A dense action inbox, with the global new-thread composer and app selector below.
struct TodoBoardView: View {
    @ObservedObject var model: InboxModel
    @ObservedObject private var workspace: TodoWorkspace
    @Environment(\.scenePhase) private var scenePhase
    @State private var destination: TodoDestination?
    @State private var snoozing: TodoQueueRow?
    @State private var showSnooze = false
    @State private var undo: (() async -> Void)?
    @State private var notice: String?
    @State private var showSearch = false
    @State private var assistant: InboxAIRequest?
    @State private var showCapture = false
    @State private var captureFocused = false
    @State private var pendingActions = Set<String>()
    @State private var captureOperations: [String: UUID] = [:]

    let onChat: () -> Void
    init(model: InboxModel, onChat: @escaping () -> Void = {}) { self.model = model; workspace = model.todoWorkspace; self.onChat = onChat }
    private var query: String {
        let typed = model.todoSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? model.todoMailQuery : typed
    }
    private var requestKey: String { model.todoInboxFilter + "\n" + model.todoSelectedAccount + "\n" + query }
    private var queue: [TodoQueueRow] {
        let filter = model.todoInboxFilter
        let search = model.todoSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        let mailOnly = ["Mail", "Drafts", "Sent", "All mail"].contains(filter)
        let mailHits = Set(workspace.threads.map { $0.connectionID + ":" + $0.id })
        var rows: [TodoQueueRow] = []
        if !["Mail", "Drafts", "Sent", "All mail"].contains(filter) {
            rows += model.todoDecisions.filter {
                ["needs_you", "preparing"].contains($0.status)
                    && (!mailOnly || $0.sourceThreadID != nil)
                    && (model.todoSelectedAccount.isEmpty || $0.sourceConnectionID == nil || $0.sourceConnectionID == model.todoSelectedAccount)
            }.map(TodoQueueRow.decision)
        }
        if !mailOnly {
            rows += model.todoItems.filter { ["captured", "watching"].contains($0.status) }.map(TodoQueueRow.capture)
            rows += model.todoInboxAgents.map(TodoQueueRow.agent)
            rows += workspace.events.filter {
                $0.endAt > .now && $0.startAt < Date.now.addingTimeInterval(86400)
                    && (model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount)
            }.map(TodoQueueRow.event)
        }
        func included(_ row: TodoQueueRow) -> Bool {
            let sleeping = model.todoRowIsSnoozed(row.snoozeID)
            guard filter == "Snoozed" ? sleeping : !sleeping else { return false }
            if case .mail = row { return true } // Gmail applies provider search syntax.
            if search.isEmpty || row.searchable.localizedCaseInsensitiveContains(search) { return true }
            if case .decision(let item) = row, let a = item.sourceConnectionID, let t = item.sourceThreadID { return mailHits.contains(a + ":" + t) }
            return false
        }
        rows = rows.filter(included)
        let linked = Set(rows.compactMap { row -> String? in
            if case .decision(let item) = row, let a = item.sourceConnectionID, let t = item.sourceThreadID { return a + ":" + t }; return nil
        })
        if filter != "Drafts" {
            var mail = workspace.threads
            if search.isEmpty && (model.todoMailQuery == "in:inbox" || filter == "Snoozed") {
                let present = Set(mail.map { $0.connectionID + ":" + $0.id })
                mail += model.todoRetainedMail.filter { !present.contains($0.connectionID + ":" + $0.id) }
            }
            rows += mail.filter {
                !linked.contains($0.connectionID + ":" + $0.id)
                    && (model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount)
            }.map(TodoQueueRow.mail).filter(included)
        }
        let visibleThreads = Set(rows.compactMap { row -> String? in
            if case .mail(let item) = row { return item.connectionID + ":" + item.id }
            if case .decision(let item) = row, let a = item.sourceConnectionID, let t = item.sourceThreadID { return a + ":" + t }; return nil
        })
        if !["Sent", "All mail"].contains(filter) {
            rows += workspace.drafts.filter {
                (model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount)
                    && (filter == "Drafts" || $0.threadID == nil || !visibleThreads.contains($0.connectionID + ":" + ($0.threadID ?? "")))
            }.map(TodoQueueRow.draft).filter(included)
        }
        let linkedAgents = Set(rows.compactMap { model.todoPreparedAgent(for: $0.id)?.id })
        rows.removeAll { if case .agent(let agent) = $0 { return linkedAgents.contains(agent.id) }; return false }
        var seen = Set<String>()
        return rows.filter { seen.insert($0.id).inserted }.sorted { a, b in
            if filter == "Snoozed" { return (model.todoSnoozed[a.snoozeID] ?? 0) < (model.todoSnoozed[b.snoozeID] ?? 0) }
            if a.rank != b.rank { return a.rank < b.rank }
            if a.date != b.date { return a.rank == 0 ? a.date < b.date : a.date > b.date }
            return a.id < b.id
        }
    }

    var body: some View {
        List {
            header
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 12))
            DisclosureGroup {
                Text("Loaded inbox mail and recent work; source coverage may be partial. Prepared suggestions do not replace original messages.")
                Text("Decision collection is Inbox-scoped; archived mail is excluded. Watch coverage is unknown.")
                    .accessibilityIdentifier("todo-source-coverage")
                if let error = model.todoSnoozeError { Text(error).foregroundStyle(.orange) }
                if model.todoSnoozeSyncPending { Text("Inbox changes saved on this device · pending sync").accessibilityIdentifier("inbox-pending-sync") }
                if let error = workspace.error { Text(error).foregroundStyle(.orange) }
                if let error = workspace.scheduleError { Text(error).foregroundStyle(.secondary) }
            } label: {
                Text(workspace.loading || model.todoLoading ? "Refreshing in the background…" : "Sync & coverage")
                    .accessibilityIdentifier("inbox-coverage")
            }
                .font(.caption).foregroundStyle(.secondary).listRowSeparator(.hidden)
            if model.todoInboxFilter != "Inbox" {
                HStack {
                    Text(model.todoInboxFilter).font(.subheadline.weight(.semibold))
                    Spacer()
                    Button("Clear filter") { selectFilter("Inbox") }.font(.caption)
                }.listRowSeparator(.hidden).accessibilityIdentifier("inbox-active-filter")
            }
            if showSearch {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search inbox", text: $model.todoSearch)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.search).accessibilityIdentifier("todo-search")
                    if !model.todoSearch.isEmpty {
                        Button { model.todoSearch = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .accessibilityLabel("Clear search")
                    }
                }
                .padding(10).background(ChatPalette.composer, in: RoundedRectangle(cornerRadius: 10))
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
            }
            if let error = model.todoError { problem(error) }
            if let error = model.doneError { problem(error) }
            if queue.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "tray").font(.title2.weight(.light)).padding(.bottom, 6)
                    Text(!model.todoLoaded && !workspace.loaded ? "Loading your inbox" : model.todoInboxFilter == "Snoozed" ? "Nothing snoozed" : "No matching items")
                        .font(.title3.weight(.semibold))
                    Text(model.todoSearch.isEmpty ? "Only loaded items are shown. Refresh or change the filter to check for more; this is not a complete mailbox sync." : "No results for this search")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 30).listRowSeparator(.hidden).accessibilityIdentifier("todo-no-decisions")
            }
            ForEach(queue) { row in
                queueRow(row)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { snoozing = row; showSnooze = true } label: { Label("Snooze", systemImage: "clock") }.tint(.indigo).disabled(!model.todoCanSnooze)
                        if case .mail(let thread) = row {
                            Button { archive(thread) } label: { Label("Archive", systemImage: "archivebox") }.tint(.gray)
                                .accessibilityIdentifier("todo-archive:" + thread.id)
                        }

                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        if model.todoInboxFilter == "Snoozed" {
                            Button { model.snoozeTodoRow(row.snoozeID, until: nil) } label: { Label("Bring back", systemImage: "sun.max") }.tint(.orange).disabled(!model.todoCanSnooze)
                        } else if case .agent(let item) = row {
                            Button { model.setSessionDone(item.id, done: true) } label: { Label("Done", systemImage: "checkmark") }.tint(.green)
                        } else if case .capture(let item) = row {
                            Button { complete(item) } label: { Label("Done", systemImage: "checkmark") }.tint(.green)
                                .accessibilityIdentifier("todo-complete:" + item.id)
                        } else if case .decision(let item) = row {
                            Button { open(row) } label: { Label("Review", systemImage: "arrow.up.right") }.tint(.blue)
                                .accessibilityIdentifier("decision-swipe-primary:" + item.id)
                        }
                    }
                    .contextMenu {
                        Button("Open") { open(row) }
                        Button("Snooze until tomorrow") { snooze(row, until: tomorrow) }.disabled(!model.todoCanSnooze)
                    }
                    .disabled(pendingActions.contains(row.id))
            }
            if workspace.hasMore && !["Snoozed", "Drafts"].contains(model.todoInboxFilter) {
                Button("Load more mail") { Task { await refreshMail(more: true) } }
                    .frame(maxWidth: .infinity, minHeight: 44).disabled(!workspace.canLoadMore(account: model.todoSelectedAccount, query: query))
                    .accessibilityIdentifier("todo-load-more")
            }

        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(ChatPalette.background)
        .overlay(alignment: .bottom) {
            if let notice {
                HStack {
                    Text(notice).font(.subheadline)
                    Spacer()
                    if let undo { Button("Undo") { Task { await undo(); self.undo = nil; self.notice = nil } }.font(.subheadline.weight(.semibold)) }
                    Button { self.notice = nil; undo = nil } label: { Image(systemName: "xmark").frame(width: 32, height: 36) }.accessibilityLabel("Dismiss notification")
                }
                .padding(.leading, 14).padding(.trailing, 4).padding(.vertical, 4)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 12).padding(.bottom, 12)
                .accessibilityIdentifier("todo-notice")
            }
        }
        .sheet(isPresented: $showCapture) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Delegate a thought for research and preparation.")
                        .font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 16)
                    TodoCaptureComposer(model: model, inputFocused: $captureFocused)
                    Spacer(minLength: 0)
                }
                .padding(.top, 16).navigationTitle("On your mind")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showCapture = false }.accessibilityIdentifier("todo-capture-done") } }
            }
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .onAppear { os_signpost(.event, log: DecisionUXMetrics.log, name: "DecisionInboxRendered") }
        .refreshable { await refreshAll(liveCalendar: true) }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await refreshAll()
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
        .task(id: requestKey) {
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await refreshMail()
        }
        .sheet(item: $destination) { selection in
            destinationView(selection).presentationDragIndicator(.visible)
        }
        .sheet(item: $assistant) { InboxAIRequestView(model: model, request: $0, onChat: onChat) }
        .confirmationDialog("Remind me", isPresented: $showSnooze, titleVisibility: .visible, presenting: snoozing) { row in
                Button("In one hour") { snooze(row, until: .now.addingTimeInterval(3600)) }
                Button("Tomorrow at 9 AM") { snooze(row, until: tomorrow) }
                Button("Next week") { snooze(row, until: .now.addingTimeInterval(7 * 86400)) }
                Button("Cancel", role: .cancel) { snoozing = nil }
        } message: { _ in Text("Snoozed items return when they are due. Pending sync is shown if the service is unavailable.") }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Menu {
                Button("All accounts") { model.todoSelectedAccount = "" }
                ForEach(workspace.accounts) { account in Button(account.email.isEmpty ? account.label : account.email) { model.todoSelectedAccount = account.id } }
            } label: {
                HStack(spacing: 6) {
                    Text("Inbox").font(.system(size: 22, weight: .semibold)).tracking(-0.6)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }.foregroundStyle(.primary)
            }.disabled(workspace.accounts.isEmpty).accessibilityIdentifier("todo-account-menu")
            Text("\(queue.count) shown").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Button { showSearch.toggle(); if !showSearch { model.todoSearch = "" } } label: { Image(systemName: "magnifyingglass").frame(width: 40, height: 44) }
                .accessibilityLabel("Search inbox").accessibilityIdentifier("todo-search-open")
                .keyboardShortcut("f", modifiers: .command)
            Menu {
                ForEach(["Inbox", "Mail", "Snoozed", "Drafts", "Sent", "All mail"], id: \.self) { value in
                    Button(value) { selectFilter(value) }.accessibilityIdentifier("todo-filter:" + value)
                }
                Divider()
                Button("Prepare a thought") { showCapture = true }
                    .accessibilityIdentifier("todo-prepare-thought")
            } label: {
                Image(systemName: model.todoInboxFilter == "Inbox" ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill").frame(width: 44, height: 44)
            }.accessibilityLabel("Filter inbox").accessibilityIdentifier("todo-filter-menu")
            Button { destination = .compose } label: { Image(systemName: "square.and.pencil").frame(width: 40, height: 44) }
                .disabled(workspace.accounts.isEmpty).accessibilityLabel("Compose email").accessibilityIdentifier("todo-compose")
                .keyboardShortcut("n", modifiers: .command)
        }.buttonStyle(.plain)
    }
    private func selectFilter(_ value: String) {
        model.todoInboxFilter = value
        switch value {
        case "Drafts": model.todoMailQuery = "in:drafts"
        case "Sent": model.todoMailQuery = "in:sent"
        case "All mail": model.todoMailQuery = ""
        default: model.todoMailQuery = "in:inbox"
        }
    }
    private func problem(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.orange).listRowSeparator(.hidden)
    }
    private func queueRow(_ row: TodoQueueRow) -> some View {
        VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 0) {
        Button { open(row) } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol(row)).font(.system(size: 15, weight: .regular))
                    .foregroundStyle(tint(row)).frame(width: 20).padding(.top, 3)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(eyebrow(row)).font(.subheadline.weight(isUnread(row) ? .bold : .semibold)).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(timing(row)).font(.caption2).foregroundStyle(row.rank == 0 ? Color.orange : Color.secondary).lineLimit(1)
                    }
                    Text(title(row)).font(.subheadline.weight(isUnread(row) ? .semibold : .regular)).lineLimit(1)
                    if !preview(row).isEmpty { Text(preview(row)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading) }
                    Text(state(row)).font(.caption).foregroundStyle(.secondary)
                    if model.todoInboxFilter == "Snoozed", let stamp = model.todoSnoozed[row.snoozeID] {
                        Text(Date(timeIntervalSince1970: stamp), style: .relative).font(.caption2).foregroundStyle(.indigo)
                    }
                }
                if isUnread(row) { Circle().fill(Color.blue).frame(width: 6, height: 6).padding(.top, 7).accessibilityLabel("Unread") }
            }.padding(.vertical, 12).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier(identifier(row))
        InboxAIActions(row: row) { text in assistant = InboxAIRequest(row: row, instructions: text) }
        }
        if let update = model.todoPreparedAgent(for: row.id), !update.isRunningInSidebar, ["Ready", "Failed"].contains(update.sidebarStatus) {
            Button { model.select(update.id); model.openThread(); onChat() } label: {
                Label(update.sidebarStatus == "Failed" ? "Review preparation problem" : "Review prepared update", systemImage: "sparkles")
                    .font(.caption.weight(.semibold)).frame(minHeight: 44)
            }.buttonStyle(.plain).padding(.leading, 30).accessibilityIdentifier("inbox-prepared-update:" + row.id)
        }
        }
    }
    private func symbol(_ row: TodoQueueRow) -> String {
        switch row { case .event: return "calendar"; case .mail: return "envelope"; case .decision: return "sparkle"; case .capture: return "circle"; case .draft: return "pencil.line"; case .agent: return "bubble.left" }
    }
    private func tint(_ row: TodoQueueRow) -> Color { row.rank == 0 ? .orange : .secondary }
    private func isUnread(_ row: TodoQueueRow) -> Bool { if case .mail(let item) = row { return item.isUnread }; return false }
    private func eyebrow(_ row: TodoQueueRow) -> String {
        switch row {
        case .event: return "Coming up"
        case .mail(let item): return item.sender.isEmpty ? "Email" : item.sender
        case .decision(let item): return item.peopleContext.people.first?.name ?? (item.sourceLabel.isEmpty ? "Needs your attention" : item.sourceLabel)
        case .agent: return "Agent work"
        case .capture: return "On your mind"
        case .draft(let item): return item.to.isEmpty ? "New draft" : "To: " + item.to.joined(separator: ", ")
        }
    }
    private func title(_ row: TodoQueueRow) -> String {
        switch row { case .event(let x): return x.title; case .mail(let x): return x.subject.isEmpty ? "(No subject)" : x.subject; case .decision(let x): return x.title; case .capture(let x): return x.body; case .draft(let x): return x.subject.isEmpty ? "(No subject)" : x.subject; case .agent(let x): return x.title }
    }
    private func preview(_ row: TodoQueueRow) -> String {
        switch row { case .event(let x): return x.briefing.isEmpty ? x.location : x.briefing; case .mail(let x): return x.snippet; case .decision(let x): return x.recommendation.isEmpty ? (x.preparationContext.isEmpty ? x.context : x.preparationContext) : x.recommendation; case .capture(let x): return x.recommendation.isEmpty ? (x.preparationError.isEmpty ? x.watchHint : x.preparationError) : x.recommendation; case .draft(let x): return x.bodyText; case .agent(let x): return x.isRunningInSidebar ? x.sidebarActivity : (x.outcomeSummary.isEmpty ? x.preview : x.outcomeSummary) }
    }
    private func timing(_ row: TodoQueueRow) -> String {
        switch row {
        case .event(let x): return x.isAllDay ? "All day" : x.startAt.formatted(date: Calendar.current.isDateInToday(x.startAt) ? .omitted : .abbreviated, time: .shortened)
        case .mail(let x): return x.updatedAt.formatted(date: Calendar.current.isDateInToday(x.updatedAt) ? .omitted : .abbreviated, time: Calendar.current.isDateInToday(x.updatedAt) ? .shortened : .omitted)
        case .decision: return "Review"
        case .capture: return "Task"
        case .draft: return "Draft"
        case .agent(let x): return x.isRunningInSidebar ? "Working" : "Review"
        }
    }
    private func state(_ row: TodoQueueRow) -> String {
        if let update = model.todoPreparedAgent(for: row.id) { return update.isRunningInSidebar ? "Preparing your request" : update.sidebarStatus == "Failed" ? "Preparation needs attention" : "Prepared update ready" }
        switch row {
        case .decision(let x): return x.isPreparedForReview ? "Ready to review" : x.preparationState.title
        case .capture(let x): return x.preparationState.title
        case .event(let x): return x.briefingState == .ready ? "Briefing ready" : x.briefingState.title
        case .mail: return "Read or respond"
        case .draft(let x): return x.isLocked ? "Check send status" : "Continue draft"
        case .agent(let x): return x.isRunningInSidebar ? "Working" : x.sidebarStatus == "Failed" ? "Needs attention" : "Review result"
        }
    }
    private func identifier(_ row: TodoQueueRow) -> String {
        if case .event(let item) = row { return "meeting-briefing:" + item.id }
        if case .decision(let item) = row { return "decision-card:" + item.id }
        return "todo-row:" + row.id
    }
    private func open(_ row: TodoQueueRow) {
        switch row {
        case .decision(let item):
            DecisionUXMetrics.beginNavigation(item.id)
            destination = .decision(item)
        case .mail(let item): workspace.prefetchMail(client: model.todoMailClient, around: item); destination = .mail(item.connectionID, item.id)
        case .event(let item): destination = .event(item)
        case .capture(let item): destination = .capture(item)
        case .draft(let item): destination = .draft(item)
        case .agent(let item): model.select(item.id); model.openThread(); onChat()
        }
    }
    @ViewBuilder private func destinationView(_ selection: TodoDestination) -> some View {
        switch selection {
        case .decision(let item): DecisionDetailView(decision: item, model: model, onChat: onChat)
        case .mail(let account, let thread, let message):
            NavigationStack {
                TodoMailThreadView(client: model.todoMailClient, inboxModel: model, onChat: onChat, inboxItemID: "mail:" + account + ":" + thread, connectionID: account, threadID: thread, replyMessageID: message, fixture: fixtureThread(id: thread))
                    .id(account + ":" + thread + ":" + (message ?? ""))
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) { Button("Done") { destination = nil }.accessibilityIdentifier("mail-thread-done") }
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            Button { stepThread(account: account, thread: thread, offset: -1) } label: { Image(systemName: "chevron.up") }
                                .disabled(adjacentThread(account: account, thread: thread, offset: -1) == nil)
                                .accessibilityLabel("Previous conversation").keyboardShortcut("k", modifiers: [])
                            Button { stepThread(account: account, thread: thread, offset: 1) } label: { Image(systemName: "chevron.down") }
                                .disabled(adjacentThread(account: account, thread: thread, offset: 1) == nil)
                                .accessibilityLabel("Next conversation").keyboardShortcut("j", modifiers: [])
                        }
                    }
            }
        case .compose:
            TodoMailComposeView(client: model.todoMailClient, inboxModel: model, onChat: onChat, connectionID: model.todoSelectedAccount.isEmpty ? (workspace.accounts.first?.id ?? "") : model.todoSelectedAccount, fixture: model.isDemo)
        case .draft(let draft): TodoMailComposeView(client: model.todoMailClient, inboxModel: model, onChat: onChat, connectionID: draft.connectionID, draftID: draft.id, fixture: model.isDemo)
        case .event(let item):
            TodoContextSheet(title: item.title, symbol: "calendar") {
                Text(item.startAt.formatted(date: .complete, time: item.isAllDay ? .omitted : .shortened)).font(.headline)
                if !item.location.isEmpty { Label(item.location, systemImage: "mappin.and.ellipse") }
                Text(item.briefingState == .ready && !item.briefing.isEmpty ? "Prepared briefing" : item.briefingState.title).font(.headline)
                if !item.briefing.isEmpty { Text(item.briefing).textSelection(.enabled) }
                else { Text("A prepared briefing is not available yet.").foregroundStyle(.secondary) }
                ForEach(Array(item.attendees.enumerated()), id: \.offset) { _, attendee in
                    DisclosureGroup(attendee.name.isEmpty ? attendee.email : attendee.name) {
                        Text("Invitee · " + (attendee.responseStatus.isEmpty ? "RSVP unknown" : attendee.responseStatus)).font(.caption)
                        ForEach(Array(attendee.context.enumerated()), id: \.offset) { _, evidence in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(evidence.text).textSelection(.enabled)
                                Text(evidence.kind + " · " + evidence.reference).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                ForEach(item.coverageReasons, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                if !item.briefingScope.isEmpty { Text(item.briefingScope).font(.caption).foregroundStyle(.secondary) }
                Text("Calendar invitations are not evidence of attendance.").font(.caption).foregroundStyle(.secondary)
                if !item.details.isEmpty { DisclosureGroup("Invitation context") { Text(item.details).textSelection(.enabled) } }
                if let url = item.url { Link("Open in Calendar", destination: url).frame(minHeight: 44) }
            }
        case .capture(let item):
            PreparedCaptureDetailView(capture: item, model: model, onChat: onChat)

        }
    }
    private func adjacentThread(account: String, thread: String, offset: Int) -> TodoMailThreadSummary? {
        let threads = workspace.threads
        guard let index = threads.firstIndex(where: { $0.connectionID == account && $0.id == thread }), threads.indices.contains(index + offset) else { return nil }
        return threads[index + offset]
    }
    private func stepThread(account: String, thread: String, offset: Int) {
        if let next = adjacentThread(account: account, thread: thread, offset: offset) { destination = .mail(next.connectionID, next.id) }
    }
    private func fixtureThread(id: String) -> TodoMailThread? {
        #if DEBUG
        guard model.isDemo else { return nil }
        if id == "fixture-budget" {
            return try? TodoMailThread(.object([
                "id": .string(id), "connection_id": .string("fixture-mail"), "subject": .string("September notes"),
                "messages": .array([.object([
                    "id": .string("fixture-budget-message"), "thread_id": .string(id),
                    "from": .string("Jordan Lee <jordan@example.com>"), "to": .string("alex@example.com"),
                    "subject": .string("September notes"), "date": .string("2026-09-30T12:00:00Z"),
                    "body_text": .string("The updated September notes are ready for your review."), "attachments": .array([])
                ])])
            ]))
        }
        return .fixture
        #else
        return nil
        #endif
    }
    private var tomorrow: Date {
        Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Calendar.current.date(byAdding: .day, value: 1, to: .now)!)!
    }
    private func snooze(_ row: TodoQueueRow, until: Date) {
        if case .mail(let thread) = row { model.retainSnoozedMail(thread) }
        model.snoozeTodoRow(row.snoozeID, until: until); snoozing = nil; notice = "Snoozed"
        undo = { model.snoozeTodoRow(row.snoozeID, until: nil) }
    }
    private func archive(_ thread: TodoMailThreadSummary) {
        Task {
            if await workspace.archive(thread, client: model.todoMailClient, demo: model.isDemo) {
                model.forgetRetainedMail(thread)
                notice = "Archived"
                undo = { _ = await workspace.archive(thread, client: model.todoMailClient, demo: model.isDemo, undo: true) }
            }
        }
    }
    private func complete(_ item: TodoCapture) {
        let key = "capture:" + item.id
        guard !pendingActions.contains(key) else { return }
        pendingActions.insert(key)
        let operation = captureOperations[key] ?? UUID(); captureOperations[key] = operation
        Task {
            defer { pendingActions.remove(key) }
            if let result = await model.setTodoCapture(item, done: true, operationID: operation) {
                captureOperations[key] = nil; notice = "Done"
                let undoOperation = UUID()
                undo = { _ = await model.setTodoCapture(result, done: false, operationID: undoOperation) }
            }
        }
    }
    private func refreshMail(more: Bool = false) async {
        await workspace.refresh(client: model.todoMailClient, account: model.todoSelectedAccount, query: query, demo: model.isDemo, more: more)
    }
    private func refreshAll(liveCalendar: Bool = false) async {
        let id = OSSignpostID(log: DecisionUXMetrics.log)
        os_signpost(.begin, log: DecisionUXMetrics.log, name: "DecisionInboxRefresh", signpostID: id)
        defer { os_signpost(.end, log: DecisionUXMetrics.log, name: "DecisionInboxRefresh", signpostID: id) }
        async let todo: Void = model.refreshTodo()
        async let mail: Void = refreshMail()
        async let schedule: Void = workspace.refreshSchedule(client: model.todoMailClient, demo: model.isDemo, liveRefresh: liveCalendar)
        _ = await (todo, mail, schedule)
        await model.reconcileRetainedTodoMail()
    }
}

private struct TodoContextSheet<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder let content: () -> Content
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: symbol).font(.title2).foregroundStyle(.secondary)
                    Text(title).font(.title2.weight(.semibold))
                    content()
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }.background(ChatPalette.background)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}

/// Composer and tab switch share one bottom safe-area dock, so neither overlays the other.
struct TodoCaptureComposer: View {
    @ObservedObject var model: InboxModel
    @Binding var inputFocused: Bool
    @State private var captureFocused = false
    @State private var overflowing = false
    @FocusState private var hintFocused: Bool
    @State private var hintExpanded = false

    private var canSave: Bool {
        !model.todoDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && model.todoDraft.utf8.count <= 4096 && !model.todoSaving
    }

    var body: some View {
        VStack(spacing: 0) {
            if let error = model.todoError {
                Text(error).font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.top, 10)
            }
            if hintExpanded || !model.todoWatchHint.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "eye").foregroundStyle(.secondary)
                    TextField("Watch for…", text: $model.todoWatchHint)
                        .focused($hintFocused).font(.subheadline)
                        .accessibilityIdentifier("todo-watch-hint")
                    Button { hintFocused = false; hintExpanded = false; model.todoWatchHint = "" } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }.accessibilityLabel("Clear watch hint")
                }
                .padding(.leading, 16).padding(.trailing, 4)
            }
            HStack(alignment: .bottom, spacing: 2) {
                Button { hintExpanded.toggle(); if hintExpanded { hintFocused = true } } label: {
                    Image(systemName: hintExpanded || !model.todoWatchHint.isEmpty ? "eye.fill" : "plus")
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Watch for a signal")
                .accessibilityIdentifier("todo-watch-toggle")
                ChatComposerEditor(text: $model.todoDraft, focused: $captureFocused,
                                   overflowing: $overflowing, accessibilityLabel: "On your mind")
                    .accessibilityIdentifier("todo-capture")
                    .overlay(alignment: .topLeading) {
                        if model.todoDraft.isEmpty {
                            Text("On your mind…").font(.body).foregroundStyle(.tertiary)
                                .padding(.top, 8).allowsHitTesting(false).accessibilityHidden(true)
                        }
                    }
                Button {
                    captureFocused = false; hintFocused = false
                    Task { await model.saveTodo() }
                } label: {
                    Group {
                        if model.todoSaving { ProgressView().tint(Color(uiColor: .systemBackground)) }
                        else { Image(systemName: "arrow.up") }
                    }
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 32, height: 32)
                    .background(Color.primary.opacity(canSave ? 1 : 0.22), in: Circle())
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!canSave)
                .accessibilityLabel("Delegate thought for preparation").accessibilityIdentifier("todo-capture-save")
            }
            .padding(.horizontal, 4).padding(.bottom, 4).padding(.top, 4)
        }
        .modifier(InboxComposerShell(focused: inputFocused))
        .frame(maxWidth: 620)
        .onChange(of: captureFocused) { _, _ in inputFocused = captureFocused || hintFocused }
        .onChange(of: hintFocused) { _, _ in inputFocused = captureFocused || hintFocused }
        .onDisappear { inputFocused = false }
    }
}

private struct DecisionDetailView: View {
    let decision: TodoDecision
    @ObservedObject var model: InboxModel
    @Environment(\.dismiss) private var dismiss
    @State private var instructions = ""
    @State private var changing = false
    @State private var mailBusy = false
    @State private var showConversation = false
    @State private var assistant: InboxAIRequest?
    let onChat: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label(decision.sourceLabel.isEmpty ? "Prepared decision" : decision.sourceLabel, systemImage: "sparkle")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(decision.title).font(.title2.weight(.semibold))
                    Text("Context").font(.headline)
                    Text(decision.preparationContext.isEmpty ? decision.context : decision.preparationContext).textSelection(.enabled)
                    if !decision.preparationScope.isEmpty { Text(decision.preparationScope).font(.caption).foregroundStyle(.secondary) }
                    ForEach(Array(decision.preparationSources.enumerated()), id: \.offset) { _, source in
                        Text(source.detail + " · " + source.reference).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    if let url = decision.sourceURL { Link("Open source", destination: url).accessibilityIdentifier("decision-source") }
                    InboxPeopleView(model: model, context: decision.peopleContext)
                    if decision.sourceConnectionID != nil && decision.sourceThreadID != nil {
                        Button("Read conversation") { showConversation = true }.buttonStyle(.bordered).accessibilityIdentifier("decision-open-conversation")
                    }
                    Text("Recommendation").font(.headline)
                    Text(decision.recommendation).textSelection(.enabled)
                    Label(decision.preparationState.title, systemImage: "sparkles")
                    if !decision.preparationError.isEmpty { Text(decision.preparationError).font(.caption).foregroundStyle(.orange) }
                    if decision.isPreparedForReview, let draft = decision.preparedDraft {
                        PreparedDecisionMailView(client: model.todoMailClient, decision: decision, draft: draft, fixture: model.isDemo, approvalBlocked: changing, busy: $mailBusy)
                            .id(draft.id + ":" + String(draft.version))
                        ForEach(decision.choices.filter { $0.id == "dismiss" || $0.id == "defer" }) { choice in
                            Button(choice.title) {
                                Task { if await model.respondTodo(to: decision, choiceID: choice.id, text: nil) { dismiss() } }
                            }.disabled(mailBusy || changing || model.todoResponding)
                        }
                    } else if decision.isPreparedForReview {
                        Text("Prepared proposal").font(.headline)
                        Text(decision.proposal).textSelection(.enabled)
                        Text("This proposal does not send email or execute external actions.").font(.caption).foregroundStyle(.secondary)
                        ForEach(decision.choices.filter { $0.id != "send" && $0.id != "approve" }) { choice in
                            Button(choice.title) { Task { if await model.respondTodo(to: decision, choiceID: choice.id, text: nil) { dismiss() } } }
                                .disabled(model.todoResponding || changing)
                        }
                    }
                    if [.failed, .blocked, .unprepared].contains(decision.preparationState) {
                        Button("Retry preparation") {
                            changing = true
                            Task {
                                if await model.prepareTodoChanges(kind: "decisions", id: decision.id, version: decision.version, text: "Retry preparation using the available source context.") { dismiss() }
                                else { changing = false }
                            }
                        }.disabled(changing || mailBusy || model.todoResponding).accessibilityIdentifier("decision-retry")
                    }
                    Text("Change this…").font(.headline)
                    TextField("Make it warmer, add context, change the plan…", text: $instructions, axis: .vertical)
                        .lineLimit(3...6).padding(12)
                        .background(ChatPalette.userBubble, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("decision-instructions")
                    Button(changing ? "Working on your changes" : "Prepare changes") {
                        changing = true
                        Task {
                            let success = await model.prepareTodoChanges(kind: "decisions", id: decision.id, version: decision.version, text: instructions.trimmingCharacters(in: .whitespacesAndNewlines))
                            if success { dismiss() } else { changing = false }
                        }
                    }.disabled(changing || mailBusy || model.todoResponding || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("decision-change")
                    if let error = model.todoError { Text(error).font(.caption).foregroundStyle(.orange) }
                    Button("Continue in Chat") {
                        assistant = InboxAIRequest(row: .decision(decision), instructions: "Help me with this prepared decision; use the attached context and original sources.")
                    }
                        .accessibilityIdentifier("decision-chat")
                }.padding(18).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }.background(ChatPalette.background)
                .navigationTitle("Decision").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.accessibilityIdentifier("decision-detail-close") } }
                .onAppear { DecisionUXMetrics.endNavigation(decision.id) }
                .safeAreaInset(edge: .bottom) {
                    HStack {
                        Text("Prepared for your review").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        InboxAIActions(row: .decision(decision)) { assistant = InboxAIRequest(row: .decision(decision), instructions: $0) }
                    }.padding(.horizontal, 18).background(.regularMaterial)
                }
                .sheet(item: $assistant) { InboxAIRequestView(model: model, request: $0, onChat: onChat) }
                .sheet(isPresented: $showConversation) {
                    if let account = decision.sourceConnectionID, let thread = decision.sourceThreadID {
                        NavigationStack {
                            TodoMailThreadView(client: model.todoMailClient, inboxModel: model, onChat: onChat, inboxItemID: "decision:" + decision.id, connectionID: account, threadID: thread, replyMessageID: decision.sourceMessageID, fixture: model.isDemo ? .fixture : nil)
                                .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { showConversation = false }.accessibilityIdentifier("mail-thread-done") } }
                        }
                    }
                }

        }
    }
}

/// Actual UI path signposts, separate from backend preparation/model latency.
private enum DecisionUXMetrics {
    static let log = OSLog(subsystem: "com.nanocodex.mobile", category: .pointsOfInterest)
    static var navigation: [String: OSSignpostID] = [:]
    static func beginNavigation(_ key: String) {
        let id = OSSignpostID(log: log); navigation[key] = id
        os_signpost(.begin, log: log, name: "DecisionNavigation", signpostID: id)
    }
    static func endNavigation(_ key: String) {
        guard let id = navigation.removeValue(forKey: key) else { return }
        os_signpost(.end, log: log, name: "DecisionNavigation", signpostID: id)
    }
}

private struct PreparedCaptureDetailView: View {
    let capture: TodoCapture
    @ObservedObject var model: InboxModel
    let onChat: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var instructions = ""
    @State private var changing = false
    @State private var assistant: InboxAIRequest?
    var body: some View {
        TodoContextSheet(title: "On your mind", symbol: "sparkles") {
            Text(capture.body).font(.title3).textSelection(.enabled)
            Label(capture.preparationState.title, systemImage: "sparkles")
            if !capture.preparationError.isEmpty { Text(capture.preparationError).foregroundStyle(.orange) }
            if !capture.preparationContext.isEmpty { Text(capture.preparationContext).textSelection(.enabled) }
            InboxPeopleView(model: model, context: capture.peopleContext)
            if !capture.recommendation.isEmpty { Text("Recommendation").font(.headline); Text(capture.recommendation).textSelection(.enabled) }
            if !capture.proposal.isEmpty { Text("Prepared proposal").font(.headline); Text(capture.proposal).textSelection(.enabled).accessibilityIdentifier("capture-proposal") }
            Text(capture.preparationScope.isEmpty ? "Captured for preparation. This is not completed work." : capture.preparationScope).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(capture.preparationSources.enumerated()), id: \.offset) { _, source in
                Text(source.detail + " · " + source.reference).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if [.failed, .blocked, .unprepared].contains(capture.preparationState) {
                Button("Retry preparation") {
                    changing = true
                    Task {
                        if await model.prepareTodoChanges(kind: "items", id: capture.id, version: capture.version, text: "Retry preparation using my captured request and available context.") { dismiss() }
                        else { changing = false }
                    }
                }.disabled(changing || model.todoResponding).accessibilityIdentifier("capture-retry")
            }
            TextField("Change this… or supply missing context", text: $instructions, axis: .vertical)
                .lineLimit(3...6).accessibilityIdentifier("capture-change-input")
            Button(changing ? "Working" : "Prepare changes") {
                changing = true
                Task {
                    if await model.prepareTodoChanges(kind: "items", id: capture.id, version: capture.version, text: instructions.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() }
                    else { changing = false }
                }
            }.disabled(changing || model.todoResponding || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text("This proposal does not send email or execute external actions.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Text("AI actions").font(.subheadline)
                Spacer()
                InboxAIActions(row: .capture(capture)) { assistant = InboxAIRequest(row: .capture(capture), instructions: $0) }
            }
            Button("Continue in Chat") { assistant = InboxAIRequest(row: .capture(capture), instructions: "Help me complete this task using the attached briefing and sources.") }
            if let error = model.todoError { Text(error).foregroundStyle(.orange) }
        }
        .sheet(item: $assistant) { InboxAIRequestView(model: model, request: $0, onChat: onChat) }
    }
}

private extension TodoQueueRow {
    var context: JSON {
        var fields: [String: JSON] = ["item_id": .string(id), "coverage": .string("Bounded retained snapshot; fetch current original sources before proposing an action.")]
        switch self {
        case .decision(let x):
            fields["title"] = .string(x.title); fields["decision_id"] = .string(x.id); fields["version"] = .number(Double(x.version))
            fields["connection_id"] = x.sourceConnectionID.map(JSON.string) ?? .null
            fields["thread_id"] = x.sourceThreadID.map(JSON.string) ?? .null
            fields["message_id"] = x.sourceMessageID.map(JSON.string) ?? .null
            fields["briefing"] = .string(x.preparationContext.isEmpty ? x.context : x.preparationContext)
            fields["recommendation"] = .string(x.recommendation); fields["proposal"] = .string(x.proposal)
            fields["crm"] = x.peopleContext.referenceSnapshot
            fields["sources"] = .array(x.preparationSources.map { .object(["kind": .string($0.kind), "reference": .string($0.reference), "detail": .string($0.detail)]) })
            if let draft = x.preparedDraft { fields["prepared_draft"] = .object(["id": .string(draft.id), "version": .number(Double(draft.version)), "to": .array(draft.to.map(JSON.string)), "subject": .string(draft.subject), "body": .string(String(draft.bodyText.prefix(8000)))]) }
        case .capture(let x):
            fields["title"] = .string(x.body); fields["capture_id"] = .string(x.id); fields["version"] = .number(Double(x.version)); fields["watch_hint"] = .string(x.watchHint)
            fields["briefing"] = .string(x.preparationContext); fields["recommendation"] = .string(x.recommendation); fields["proposal"] = .string(x.proposal); fields["missing_information"] = .string(x.preparationError)
            fields["crm"] = x.peopleContext.referenceSnapshot
            fields["sources"] = .array(x.preparationSources.map { .object(["kind": .string($0.kind), "reference": .string($0.reference), "detail": .string($0.detail)]) })
        case .mail(let x):
            fields["title"] = .string(x.subject); fields["connection_id"] = .string(x.connectionID); fields["thread_id"] = .string(x.id); fields["sender"] = .string(x.sender); fields["snippet"] = .string(x.snippet)
            fields["crm"] = x.peopleContext?.referenceSnapshot ?? .null
        case .draft(let x):
            fields["title"] = .string(x.subject); fields["connection_id"] = .string(x.connectionID); fields["draft_id"] = .string(x.id); fields["to"] = .array(x.to.map(JSON.string)); fields["body"] = .string(String(x.bodyText.prefix(8000)))
        case .event(let x):
            fields["title"] = .string(x.title); fields["connection_id"] = .string(x.connectionID); fields["calendar_id"] = .string(x.calendarID); fields["event_id"] = .string(x.eventID)
            fields["start"] = .string(x.startAt.ISO8601Format()); fields["location"] = .string(x.location); fields["briefing"] = .string(x.briefing); fields["invitation_context"] = .string(String(x.details.prefix(4000)))
            fields["attendees"] = .array(x.attendees.map { .object(["name": .string($0.name), "email": .string($0.email), "crm_record_id": $0.personID.map(JSON.string) ?? .null, "rsvp": .string($0.responseStatus)]) })
        case .agent(let x):
            fields["title"] = .string(x.title); fields["agent_id"] = .string(x.id); fields["last_request"] = .string(x.sidebarLastUserPrompt); fields["result"] = .string(x.outcomeSummary.isEmpty ? x.preview : x.outcomeSummary); fields["state"] = .string(x.sidebarStatus)
        }
        return .object(fields)
    }
    var isEmail: Bool { switch self { case .mail, .draft: return true; case .decision(let x): return x.sourceThreadID != nil; default: return false } }
}

struct InboxAIRequest: Identifiable {
    let id: String
    let context: JSON
    let instructions: String
    fileprivate init(row: TodoQueueRow, instructions: String) { id = row.id; context = row.context; self.instructions = instructions }
    init(id: String, context: JSON, instructions: String) { self.id = id; self.context = context; self.instructions = instructions }
}

private struct InboxAIActions: View {
    let row: TodoQueueRow
    let prepare: (String) -> Void
    var body: some View {
        Menu {
            Button("Brief me") { prepare("Brief me on what needs my attention, relevant verified CRM people, prior context and missing information.") }
            Button("Prepare next steps") { prepare("Prepare complete next steps for my review, linking verified CRM people and original sources. Flag missing facts; do not act externally.") }
            if row.isEmail { Button("Draft reply") { prepare("Prepare an editable reply using the full current conversation and verified CRM context. Do not send; ask for missing decisions instead of guessing.") } }
            Button("Ask something else") { prepare("") }
        } label: { Image(systemName: "sparkles").font(.subheadline).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .accessibilityLabel("AI actions").accessibilityIdentifier("inbox-ai:" + row.id)
    }
}

struct InboxAIRequestView: View {
    @ObservedObject var model: InboxModel
    let request: InboxAIRequest
    let onChat: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var instructions: String
    @State private var targetID: String?
    @State private var submitting = false
    @State private var error: String?
    private let account: UUID
    init(model: InboxModel, request: InboxAIRequest, onChat: @escaping () -> Void) {
        self.model = model; self.request = request; self.onChat = onChat; account = model.vaultIntakeAccount
        _instructions = State(initialValue: request.instructions)
        _targetID = State(initialValue: model.todoPreparedAgent(for: request.context["item_id"].string)?.id)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Already attached") {
                    Text(request.context["title"].string).font(.headline).accessibilityIdentifier("inbox-ai-context")
                    let brief = request.context["briefing"].string.isEmpty ? request.context["snippet"].string : request.context["briefing"].string
                    if !brief.isEmpty { Text(brief).font(.subheadline).foregroundStyle(.secondary) }
                    DisclosureGroup("Source details") { Text(request.context.pretty).font(.caption).textSelection(.enabled) }
                }
                Section("Prepare for me") {
                    TextField("What would you like prepared?", text: $instructions, axis: .vertical).lineLimit(3...8).accessibilityIdentifier("inbox-ai-instructions")
                    Text("Prepares work for review. Does not send, approve or execute external actions.").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Section { Text(error).foregroundStyle(.orange) } }
            }.navigationTitle("AI action").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } } }
                .safeAreaInset(edge: .bottom) {
                    Button("Prepare") {
                        guard !submitting else { return }
                        submitting = true
                        if model.prepareInboxAction(context: request.context, instructions: instructions, account: account, targetID: &targetID) {
                            dismiss()
                            // Demo stays on Inbox so fixtures can review the original
                            // item; real preparation follows its durable conversation.
                            if !model.isDemo { onChat() }
                        } else { submitting = false; error = model.error ?? "Couldn't queue preparation. Your request is still here." }
                    }.buttonStyle(.borderedProminent).frame(maxWidth: .infinity, minHeight: 44).padding().background(.regularMaterial)
                        .disabled(submitting || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || account != model.vaultIntakeAccount).accessibilityIdentifier("inbox-ai-prepare")
                }
        }
    }
}

struct InboxPeopleView: View {
    @ObservedObject var model: InboxModel
    let context: TodoPeopleContext
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("People & context").font(.headline)
            ForEach(context.people) { person in
                VStack(alignment: .leading, spacing: 6) {
                    NavigationLink { CRMProfileView(model: model, recordID: person.recordID) } label: {
                        HStack {
                            Image(systemName: "person.crop.circle")
                            VStack(alignment: .leading, spacing: 3) {
                                Text(person.name.isEmpty ? person.email : person.name).font(.subheadline.weight(.semibold))
                                Text([person.title, person.company].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(); Image(systemName: "chevron.right").font(.caption)
                        }.frame(minHeight: 44)
                    }.accessibilityIdentifier("inbox-crm:" + person.recordID)
                    if !person.summary.isEmpty { Text(person.summary).font(.subheadline) }
                    if !person.timeline.isEmpty {
                        DisclosureGroup("Recent saved context") {
                            ForEach(Array(person.timeline.enumerated()), id: \.offset) { _, entry in
                                Text(entry.text).font(.subheadline)
                                Text((entry.timestampBasis == "created_at" ? "Recorded " : "") + entry.occurredAt).font(.caption).foregroundStyle(.secondary)
                                ForEach(Array(entry.sources.enumerated()), id: \.offset) { _, source in Text(source.kind + " · " + source.reference).font(.caption2).foregroundStyle(.secondary) }
                            }
                        }.font(.caption)
                    }
                    Text(person.match == "exact_alias" ? "Matched saved email alias" : "Matched saved email").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if context.people.isEmpty || context.status != "matched" {
                Text(context.status == "ambiguous" ? "CRM identity is ambiguous. No profile has been guessed." : context.status == "partial" ? "Some CRM context is unavailable or unmatched." : "No verified CRM profile is linked yet.").font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup("Context coverage") {
                ForEach(context.coverageReasons, id: \.self) { Text($0).font(.caption) }
                Text("Saved context may be stale. An address match does not authenticate the sender.").font(.caption)
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
}
