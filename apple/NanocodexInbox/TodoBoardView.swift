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
    case decision(TodoDecision), mail(TodoMailThreadSummary), event(TodoScheduleEvent), capture(TodoCapture), draft(TodoMailDraft)
    var id: String {
        switch self {
        case .decision(let item): return "decision:" + item.id
        case .mail(let item): return "mail:" + item.connectionID + ":" + item.id
        case .event(let item): return "event:" + item.id
        case .capture(let item): return "capture:" + item.id
        case .draft(let item): return "draft:" + item.id
        }
    }
    var snoozeID: String {
        if case .decision(let item) = self, let account = item.sourceConnectionID, let thread = item.sourceThreadID { return "mail:" + account + ":" + thread }
        return id
    }
    var rank: Int {
        switch self {
        case .event(let event): return event.startAt < Date.now.addingTimeInterval(3600) ? 0 : 4
        case .decision: return 1
        case .draft: return 2
        case .capture: return 3
        case .mail: return 5
        }
    }
    var date: Date {
        switch self {
        case .event(let item): return item.startAt
        case .mail(let item): return item.updatedAt
        case .capture(let item): return ISO8601DateFormatter().date(from: item.createdAt) ?? .distantPast
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
        }
    }
}

/// A dense action inbox, with the existing capture composer and app selector below.
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
    @State private var showDiagnostics = false
    @State private var pendingActions = Set<String>()
    @State private var captureOperations: [String: UUID] = [:]

    let onChat: () -> Void
    init(model: InboxModel, onChat: @escaping () -> Void = {}) { self.model = model; workspace = model.todoWorkspace; self.onChat = onChat }
    private var query: String {
        let typed = model.todoSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? model.todoMailQuery : typed
    }
    private var requestKey: String { model.todoSplit + "\n" + model.todoSelectedAccount + "\n" + query }
    private var queue: [TodoQueueRow] {
        var rows: [TodoQueueRow] = []
        let search = model.todoSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        let mailOnly = model.todoSplit == "Mail"
        if !mailOnly {
            rows += model.todoItems.filter { $0.status == "captured" && $0.preparationState == .ready && !$0.proposal.isEmpty && !$0.recommendation.isEmpty }.map(TodoQueueRow.capture)
            rows += model.todoDecisions.filter { $0.isPreparedForReview && (model.todoSelectedAccount.isEmpty || $0.sourceConnectionID == nil || $0.sourceConnectionID == model.todoSelectedAccount) }.map(TodoQueueRow.decision)
        }
        let linked = Set(rows.compactMap { row -> String? in
            let sleeping = model.todoRowIsSnoozed(row.snoozeID)
            guard (model.todoSplit == "Later" ? sleeping : !sleeping),
                  search.isEmpty || row.searchable.localizedCaseInsensitiveContains(search),
                  case .decision(let item) = row, let connection = item.sourceConnectionID, let thread = item.sourceThreadID else { return nil }
            return connection + ":" + thread
        })
        if mailOnly && model.todoMailQuery == "in:drafts" {
            rows += workspace.drafts.filter { model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount }.map(TodoQueueRow.draft)
        } else if mailOnly || model.todoSplit == "Later" {
            var mail = workspace.threads.filter { model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount }
            if model.todoSearch.isEmpty && (model.todoMailQuery == "in:inbox" || model.todoSplit == "Later") {
                let present = Set(mail.map { $0.connectionID + ":" + $0.id })
                mail += model.todoRetainedMail.filter {
                    !present.contains($0.connectionID + ":" + $0.id) && (model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount)
                }
            }
            rows += mail.filter { !linked.contains($0.connectionID + ":" + $0.id) }.map(TodoQueueRow.mail)
            if !mailOnly { rows += workspace.drafts.filter { $0.threadID == nil && (model.todoSelectedAccount.isEmpty || $0.connectionID == model.todoSelectedAccount) }.map(TodoQueueRow.draft) }
        }
        var seenRows = Set<String>()
        return rows.filter { row in
            let sleeping = model.todoRowIsSnoozed(row.snoozeID)
            guard model.todoSplit == "Later" ? sleeping : !sleeping else { return false }
            if case .mail = row { return true } // Gmail already applied its richer search syntax.
            return search.isEmpty || row.searchable.localizedCaseInsensitiveContains(search)
        }.filter { seenRows.insert($0.id).inserted }.sorted { lhs, rhs in
            if model.todoSplit == "Later" { return (model.todoSnoozed[lhs.snoozeID] ?? 0) < (model.todoSnoozed[rhs.snoozeID] ?? 0) }
            if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
            if lhs.rank == 4 || lhs.rank == 0 { return lhs.date < rhs.date }
            if lhs.date != rhs.date { return lhs.date > rhs.date }
            return lhs.id < rhs.id
        }
    }

    var body: some View {
        List {
            header
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 12))
            if showSearch {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(model.todoSplit == "Mail" ? "Search mail" : "Search decisions", text: $model.todoSearch)
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
            HStack(spacing: 20) {
                ForEach(["For you", "Mail", "Later"], id: \.self) { split in
                    Button {
                        model.todoSplit = split
                        if split == "For you" { model.todoMailQuery = "in:inbox" }
                    } label: {
                        VStack(spacing: 8) {
                            Text(split).font(.subheadline.weight(model.todoSplit == split ? .semibold : .regular))
                                .foregroundStyle(model.todoSplit == split ? Color.primary : Color.secondary)
                            Rectangle().fill(model.todoSplit == split ? Color.primary : .clear).frame(height: 2)
                        }
                    }.buttonStyle(.plain).accessibilityIdentifier("todo-split:" + split)
                }
                Spacer(minLength: 0)
                if workspace.loading { ProgressView().controlSize(.mini) }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            if let error = workspace.error, model.todoSplit == "Mail" { problem(error) }
            if let error = model.todoError { problem(error) }
            if let error = workspace.scheduleError, model.todoSplit != "Mail" { problem(error) }
            if !workspace.accounts.isEmpty && model.todoSplit == "Mail" {
                mailFilters.listRowSeparator(.hidden)
            }
            if model.todoSplit == "For you" {
                upcomingMeetings
                preparationActivity
            }
            if queue.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: workspace.loading ? "tray" : "checkmark").font(.title2.weight(.light)).padding(.bottom, 6)
                    Text(!model.todoLoaded ? "Loading prepared decisions" : model.todoError != nil ? "Decision inbox unavailable" : model.todoSplit == "Later" ? "Nothing snoozed" : "No prepared decisions")
                        .font(.title3.weight(.semibold))
                    Text(model.todoSearch.isEmpty ? "Only complete proposals appear here. Working and blocked preparation stays visible separately. This is not your entire mailbox." : "No results for this search")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 30).listRowSeparator(.hidden).accessibilityIdentifier("todo-no-decisions")
            }
            ForEach(queue) { row in
                queueRow(row)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button { snoozing = row; showSnooze = true } label: { Label("Snooze", systemImage: "clock") }.tint(.indigo)
                        if case .mail(let thread) = row {
                            Button { archive(thread) } label: { Label("Archive", systemImage: "archivebox") }.tint(.gray)
                                .accessibilityIdentifier("todo-archive:" + thread.id)
                        }

                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        if model.todoSplit == "Later" {
                            Button { model.snoozeTodoRow(row.snoozeID, until: nil) } label: { Label("Bring back", systemImage: "sun.max") }.tint(.orange)
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
                        Button("Snooze until tomorrow") { snooze(row, until: tomorrow) }
                    }
                    .disabled(pendingActions.contains(row.id))
            }
            if workspace.hasMore && model.todoSplit == "Mail" {
                Button("Load more mail") { Task { await refreshMail(more: true) } }
                    .frame(maxWidth: .infinity, minHeight: 44).disabled(!workspace.canLoadMore(account: model.todoSelectedAccount, query: query))
                    .accessibilityIdentifier("todo-load-more")
            }
            if !model.todoTraces.isEmpty && model.todoSplit == "Mail" {
                DisclosureGroup("Classification diagnostics", isExpanded: $showDiagnostics) {
                    ForEach(model.todoTraces) { trace in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(trace.title).font(.subheadline.weight(.medium))
                            Text(trace.sender).font(.caption).foregroundStyle(.secondary)
                            Text(trace.reasonLabel).font(.caption).foregroundStyle(.secondary)
                            Text(trace.outcomeLabel).font(.caption2).foregroundStyle(.tertiary)
                            if let url = trace.sourceURL { Link("Open source", destination: url).font(.caption) }
                        }.padding(.vertical, 5).accessibilityIdentifier("todo-trace:\(trace.id)")
                    }
                    Text("Up to 100 recent results from the last 90 days.").font(.caption2).foregroundStyle(.secondary)
                }.font(.caption).foregroundStyle(.secondary)
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
                .padding(.horizontal, 12).padding(.bottom, 138)
                .accessibilityIdentifier("todo-notice")
            }
        }
        .onAppear { os_signpost(.event, log: DecisionUXMetrics.log, name: "DecisionInboxRendered") }
        .refreshable { await refreshAll(liveCalendar: true) }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await refreshAll()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .task(id: requestKey) {
            guard model.todoSplit == "Mail" else { return }
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await refreshMail()
        }
        .sheet(item: $destination) { selection in
            destinationView(selection).presentationDragIndicator(.visible)
        }
        .confirmationDialog("Remind me", isPresented: $showSnooze, titleVisibility: .visible, presenting: snoozing) { row in
                Button("In one hour") { snooze(row, until: .now.addingTimeInterval(3600)) }
                Button("Tomorrow at 9 AM") { snooze(row, until: tomorrow) }
                Button("Next week") { snooze(row, until: .now.addingTimeInterval(7 * 86400)) }
                Button("Cancel", role: .cancel) { snoozing = nil }
        } message: { _ in Text("Snoozed items return to this device's queue when they're due.") }
    }

    @ViewBuilder private var upcomingMeetings: some View {
        let upcoming = workspace.events.filter { $0.endAt > .now }.sorted { $0.startAt < $1.startAt }.prefix(3)
        if !upcoming.isEmpty {
            Section("Upcoming meetings") {
                ForEach(Array(upcoming)) { event in
                    Button { destination = .event(event) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.title).font(.subheadline.weight(.semibold))
                            Text(event.startAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                            Text(event.briefingState == .ready && !event.briefing.isEmpty ? event.briefing : "Briefing · " + event.briefingState.title)
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }.buttonStyle(.plain).accessibilityIdentifier("meeting-briefing:" + event.id)
                }
            }
        }
    }
    @ViewBuilder private var preparationActivity: some View {
        let captures = model.todoItems.filter { $0.status != "done" && ($0.preparationState != .ready || $0.proposal.isEmpty || $0.recommendation.isEmpty) }
        let preparing = model.todoDecisions.filter { $0.status == "preparing" || ($0.status == "needs_you" && !$0.isPreparedForReview) }
        if !captures.isEmpty || !preparing.isEmpty {
            Section("Preparation") {
                ForEach(captures) { item in
                    Button { destination = .capture(item) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.body).font(.subheadline).lineLimit(2)
                            Text(item.preparationState.title).font(.caption.weight(.semibold)).foregroundStyle(item.preparationState == .blocked ? Color.orange : Color.secondary)
                            if !item.preparationError.isEmpty { Text(item.preparationError).font(.caption).foregroundStyle(.orange) }
                        }
                    }.buttonStyle(.plain).accessibilityIdentifier("capture-preparation:" + item.id)
                }
                ForEach(preparing) { item in
                    Button { destination = .decision(item) } label: { VStack(alignment: .leading, spacing: 4) {
                        Text(item.title).font(.subheadline)
                        Text(item.preparationState == .ready ? "Blocked · incomplete proposal" : item.preparationState.title).font(.caption).foregroundStyle(.secondary)
                        if !item.preparationError.isEmpty { Text(item.preparationError).font(.caption).foregroundStyle(.orange) }
                    } }.buttonStyle(.plain).accessibilityIdentifier("decision-preparation:" + item.id)
                }
            }
        }
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
            Text("\(queue.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Button { showSearch.toggle(); if !showSearch { model.todoSearch = "" } } label: { Image(systemName: "magnifyingglass").frame(width: 40, height: 44) }
                .accessibilityLabel("Search inbox").accessibilityIdentifier("todo-search-open")
                .keyboardShortcut("f", modifiers: .command)
            Button { destination = .compose } label: { Image(systemName: "square.and.pencil").frame(width: 40, height: 44) }
                .disabled(workspace.accounts.isEmpty).accessibilityLabel("Compose email").accessibilityIdentifier("todo-compose")
                .keyboardShortcut("n", modifiers: .command)
        }.buttonStyle(.plain)
    }
    private var mailFilters: some View {
        HStack {
            Menu {
                Button("Inbox") { model.todoMailQuery = "in:inbox" }
                Button("Unread") { model.todoMailQuery = "in:inbox is:unread" }
                Button("Drafts") { model.todoMailQuery = "in:drafts" }
                Button("Sent") { model.todoMailQuery = "in:sent" }
                Button("All mail") { model.todoMailQuery = "" }
            } label: {
                Label(model.todoMailQuery == "in:drafts" ? "Drafts" : model.todoMailQuery == "in:sent" ? "Sent" : model.todoMailQuery.isEmpty ? "All mail" : model.todoMailQuery.contains("is:unread") ? "Unread" : "Inbox", systemImage: "line.3.horizontal.decrease")
            }.accessibilityIdentifier("todo-mail-filter")
            Spacer()
            Text(workspace.accounts.first(where: { $0.id == model.todoSelectedAccount })?.email ?? "All accounts").foregroundStyle(.secondary).lineLimit(1)
        }.font(.caption)
    }
    private func problem(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.orange).listRowSeparator(.hidden)
    }
    private func queueRow(_ row: TodoQueueRow) -> some View {
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
                    if !preview(row).isEmpty { Text(preview(row)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
                    if model.todoSplit == "Later", let stamp = model.todoSnoozed[row.snoozeID] {
                        Text(Date(timeIntervalSince1970: stamp), style: .relative).font(.caption2).foregroundStyle(.indigo)
                    }
                }
                if isUnread(row) { Circle().fill(Color.blue).frame(width: 6, height: 6).padding(.top, 7).accessibilityLabel("Unread") }
            }.padding(.vertical, 12).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityIdentifier(identifier(row))
    }
    private func symbol(_ row: TodoQueueRow) -> String {
        switch row { case .event: return "calendar"; case .mail: return "envelope"; case .decision: return "sparkle"; case .capture: return "circle"; case .draft: return "pencil.line" }
    }
    private func tint(_ row: TodoQueueRow) -> Color { row.rank == 0 ? .orange : .secondary }
    private func isUnread(_ row: TodoQueueRow) -> Bool { if case .mail(let item) = row { return item.isUnread }; return false }
    private func eyebrow(_ row: TodoQueueRow) -> String {
        switch row {
        case .event: return "Coming up"
        case .mail(let item): return item.sender.isEmpty ? "Email" : item.sender
        case .decision(let item): return item.sourceLabel.isEmpty ? "Needs your attention" : item.sourceLabel
        case .capture: return "On your mind"
        case .draft(let item): return item.to.isEmpty ? "New draft" : "To: " + item.to.joined(separator: ", ")
        }
    }
    private func title(_ row: TodoQueueRow) -> String {
        switch row { case .event(let x): return x.title; case .mail(let x): return x.subject.isEmpty ? "(No subject)" : x.subject; case .decision(let x): return x.title; case .capture(let x): return x.body; case .draft(let x): return x.subject.isEmpty ? "(No subject)" : x.subject }
    }
    private func preview(_ row: TodoQueueRow) -> String {
        switch row { case .event(let x): return x.location; case .mail(let x): return x.snippet; case .decision(let x): return x.context; case .capture(let x): return x.watchHint; case .draft(let x): return x.bodyText }
    }
    private func timing(_ row: TodoQueueRow) -> String {
        switch row {
        case .event(let x): return x.isAllDay ? "All day" : x.startAt.formatted(date: Calendar.current.isDateInToday(x.startAt) ? .omitted : .abbreviated, time: .shortened)
        case .mail(let x): return x.updatedAt.formatted(date: Calendar.current.isDateInToday(x.updatedAt) ? .omitted : .abbreviated, time: Calendar.current.isDateInToday(x.updatedAt) ? .shortened : .omitted)
        case .decision: return "Review"
        case .capture: return "Task"
        case .draft: return "Draft"
        }
    }
    private func identifier(_ row: TodoQueueRow) -> String {
        if case .decision(let item) = row { return "decision-card:" + item.id }
        return "todo-row:" + row.id
    }
    private func open(_ row: TodoQueueRow) {
        switch row {
        case .decision(let item):
            DecisionUXMetrics.beginNavigation(item.id)
            destination = .decision(item)
        case .mail(let item): destination = .mail(item.connectionID, item.id)
        case .event(let item): destination = .event(item)
        case .capture(let item): destination = .capture(item)
        case .draft(let item): destination = .draft(item)
        }
    }
    @ViewBuilder private func destinationView(_ selection: TodoDestination) -> some View {
        switch selection {
        case .decision(let item): DecisionDetailView(decision: item, model: model, onChat: onChat)
        case .mail(let account, let thread, let message):
            NavigationStack {
                TodoMailThreadView(client: model.todoMailClient, connectionID: account, threadID: thread, replyMessageID: message, fixture: fixtureThread)
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
            TodoMailComposeView(client: model.todoMailClient, connectionID: model.todoSelectedAccount.isEmpty ? (workspace.accounts.first?.id ?? "") : model.todoSelectedAccount, fixture: model.isDemo)
        case .draft(let draft): TodoMailComposeView(client: model.todoMailClient, connectionID: draft.connectionID, draftID: draft.id, fixture: model.isDemo)
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
    private var fixtureThread: TodoMailThread? {
        #if DEBUG
        return model.isDemo ? .fixture : nil
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
        await model.refreshTodo()
        if model.todoSplit == "Mail" { await refreshMail() }
        await workspace.refreshSchedule(client: model.todoMailClient, demo: model.isDemo, liveRefresh: liveCalendar)
        if model.todoSplit == "Mail" { await model.reconcileRetainedTodoMail() }
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
                    Button("Continue in Chat") { dismiss(); onChat() }
                        .accessibilityIdentifier("decision-chat")
                }.padding(18).frame(maxWidth: 620, alignment: .leading).frame(maxWidth: .infinity)
            }.background(ChatPalette.background)
                .navigationTitle("Decision").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.accessibilityIdentifier("decision-detail-close") } }
                .onAppear { DecisionUXMetrics.endNavigation(decision.id) }
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
    var body: some View {
        TodoContextSheet(title: "On your mind", symbol: "sparkles") {
            Text(capture.body).font(.title3).textSelection(.enabled)
            Label(capture.preparationState.title, systemImage: "sparkles")
            if !capture.preparationError.isEmpty { Text(capture.preparationError).foregroundStyle(.orange) }
            if !capture.preparationContext.isEmpty { Text(capture.preparationContext).textSelection(.enabled) }
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
            Button("Continue in Chat") { dismiss(); onChat() }
            if let error = model.todoError { Text(error).foregroundStyle(.orange) }
        }
    }
}
