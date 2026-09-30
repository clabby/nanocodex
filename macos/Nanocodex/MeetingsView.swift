import SwiftUI
import InboxCore
import NanocodexUI

/// Account-scoped, demand-driven library. Every completion is bound to both the
/// account generation and selection; navigating away cancels outstanding work.
@MainActor
final class MacMeetingLibrary: ObservableObject {
    @Published private(set) var meetings: [MeetingRecord] = []
    @Published private(set) var record: MeetingRecord?
    @Published private(set) var loading = false
    @Published private(set) var detailLoading = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var detailError: String?
    @Published private(set) var nextCursor: String?
    @Published var selectedID: UUID?
    @Published var notes = "" { didSet { if !applyingEditor { rememberDraft() } } }
    @Published var query = ""
    private var detailRefreshing = false
    private var failedLoadMore = false
    private typealias PendingSave = MacMeetingSaveJournal.Submission
    private var scope: String?
    private var journal: MacMeetingSaveJournal?
    private var journalFailure: String?
    private var applyingEditor = false

    init(journal: MacMeetingSaveJournal? = nil) {
        do { self.journal = try journal ?? MacMeetingSaveJournal(url: MacMeetingSaveJournal.defaultURL()) }
        catch { journalFailure = error.localizedDescription }
    }
    func activate(scope: String?) {
        guard self.scope != scope else { return }
        reset()
        self.scope = scope
        guard let scope, let journal else { detailError = journalFailure; return }
        for entry in journal.entries(scope: scope) {
            drafts[entry.record.id] = (entry.record, entry.notes)
            if let submitted = entry.submitted { pendingSaves[entry.record.id] = submitted }
        }
        meetings = drafts.values.map(\.record).sorted { $0.startedAt > $1.startedAt }
    }
    private func setEditor(_ value: MeetingRecord?, notes: String) {
        applyingEditor = true
        record = value; self.notes = notes
        applyingEditor = false
    }
    private func writableJournal() throws -> (String, MacMeetingSaveJournal) {
        guard let scope else { throw MacMeetingSaveJournal.JournalError.invalidScope }
        guard let journal else { throw MacMeetingSaveJournal.JournalError.invalidDocument }
        return (scope, journal)
    }
    private var pendingSaves: [UUID: PendingSave] = [:]
    private var drafts: [UUID: (record: MeetingRecord, notes: String)] = [:]
    private var epoch = 0
    private var selectionEpoch = 0
    private var clients: [UUID: ManagedClient] = [:]
    var client: (() throws -> ManagedClient)?

    var filtered: [MeetingRecord] {
        meetings.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
    }
    var hasChanges: Bool { record.map { notes != $0.notes } ?? false }
    var hasPendingSave: Bool { record.map { pendingSaves[$0.id] != nil } ?? false }
    var canSave: Bool { hasChanges || hasPendingSave }
    private func rememberDraft() {
        guard let record else { return }
        if canSave { drafts[record.id] = (record, notes) }
        else { drafts.removeValue(forKey: record.id) }
        if let scope, let journal {
            do { try journal.saveDraft(record: record, notes: notes, scope: scope) }
            catch { detailError = error.localizedDescription }
        }
    }
    func suspend() {
        rememberDraft()
        epoch += 1; selectionEpoch += 1
        clients.values.forEach { $0.close() }; clients = [:]
        loading = false; detailLoading = false; detailRefreshing = false; busy = false
    }
    func reset() {
        // The factory weakly resolves the app's *current* credential on demand,
        // so reconnecting the same account works without a scene-id change.
        suspend(); scope = nil; meetings = []; setEditor(nil, notes: ""); selectedID = nil
        query = ""; nextCursor = nil; error = nil; detailError = nil; drafts = [:]; pendingSaves = [:]
    }
    private func begin() throws -> (UUID, ManagedClient) {
        guard scope != nil, let client else { throw APIError.invalidCredential }
        let value = try client(), id = UUID(); clients[id] = value
        return (id, value)
    }
    private func end(_ id: UUID) { clients.removeValue(forKey: id)?.close() }
    func load(more: Bool = false) async {
        guard !loading, !busy else { return }
        let generation = epoch
        failedLoadMore = more
        loading = true; error = nil
        defer { if epoch == generation { loading = false } }
        do {
            let (id, api) = try begin(); defer { end(id) }
            let page = try await api.meetings(cursor: more ? nextCursor : nil, limit: 50)
            guard epoch == generation, !Task.isCancelled else { return }
            if more {
                let known = Set(meetings.map(\.id)); meetings += page.meetings.filter { !known.contains($0.id) }
            } else {
                let listed = Set(page.meetings.map(\.id))
                meetings = page.meetings + drafts.values.map(\.record).filter { !listed.contains($0.id) }
            }
            nextCursor = page.nextCursor
        } catch { if epoch == generation, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func retryLoad() async { await load(more: failedLoadMore) }
    func refresh() async {
        guard !loading, !busy else { return }
        let generation = epoch
        await load()
        guard epoch == generation, !Task.isCancelled else { return }
        if let id = selectedID {
            if record?.id == id { await revalidateSelected(id) }
            else { await select(id) }
        }
    }
    private func revalidateSelected(_ id: UUID) async {
        guard !canSave, !detailLoading, !detailRefreshing, !busy else { return }
        let generation = epoch, selection = selectionEpoch, baselineNotes = notes
        detailRefreshing = true
        defer { if epoch == generation { detailRefreshing = false } }
        do {
            let (key, api) = try begin(); defer { end(key) }
            let value = try await api.meeting(id: id)
            guard epoch == generation, selectionEpoch == selection, selectedID == id, !Task.isCancelled else { return }
            // Keep the editor mounted while refreshing. A keystroke or pending
            // save since this GET began owns the draft, never the response.
            guard notes == baselineNotes, !canSave else { return }
            setEditor(value, notes: value.notes); detailError = nil
        } catch {
            if epoch == generation, selectionEpoch == selection, !Task.isCancelled { detailError = error.localizedDescription }
        }
    }
    func select(_ id: UUID, discardDraft: Bool = false) async {
        guard !busy else { return }
        rememberDraft()
        if discardDraft {
            do {
                let (scope, journal) = try writableJournal()
                try journal.remove(id: id, scope: scope)
                drafts.removeValue(forKey: id); pendingSaves.removeValue(forKey: id)
            } catch { detailError = error.localizedDescription; return }
        }

        selectionEpoch += 1
        let generation = epoch, selection = selectionEpoch
        selectedID = id; setEditor(nil, notes: ""); detailError = nil
        if let draft = drafts[id] {
            setEditor(draft.record, notes: draft.notes); detailLoading = false
            return
        }
        detailLoading = true
        defer { if epoch == generation, selectionEpoch == selection { detailLoading = false } }
        do {
            let (key, api) = try begin(); defer { end(key) }
            let value = try await api.meeting(id: id)
            guard epoch == generation, selectionEpoch == selection, selectedID == id, !Task.isCancelled else { return }
            setEditor(value, notes: value.notes)
        } catch { if epoch == generation, selectionEpoch == selection, !Task.isCancelled { detailError = error.localizedDescription } }
    }
    enum Action: Equatable { case save, summarize, delete }
    func perform(_ action: Action) async {
        guard let record, !busy else { return }
        let generation = epoch, selection = selectionEpoch
        busy = true; detailError = nil
        var submission: PendingSave?
        defer { if epoch == generation { busy = false } }
        do {
            let (key, api) = try begin(); defer { end(key) }
            let value: MeetingRecord?
            switch action {
            case .save:
                // Keep the exact payload and CAS base through a lost response.
                // Later typing is a new draft, never a mutated idempotent retry.
                let (scope, journal) = try writableJournal()
                let submitted = try journal.prepare(record: record, notes: notes, scope: scope)
                submission = submitted
                pendingSaves[record.id] = submitted
                rememberDraft()
                value = try await api.saveMeeting(submitted.record, ifMatch: submitted.ifMatch)
            case .summarize:
                // Successful summaries are immutable per saved revision;
                // known failures retry using the server's bounded retry lease.
                value = try await api.summarizeMeeting(id: record.id, revision: record.revision)
            case .delete: try await api.deleteMeeting(id: record.id); value = nil
            }
            guard epoch == generation, selectionEpoch == selection, !Task.isCancelled else { return }
            if let value {
                var latestNotes = notes
                if action == .save, let submission {
                    let (scope, journal) = try writableJournal()
                    // Fail closed if a later keystroke could not be persisted;
                    // never replace that live text with an older journal copy.
                    try journal.saveDraft(record: record, notes: notes, scope: scope)
                    try journal.acknowledge(submission, remote: value, scope: scope)
                    latestNotes = journal.entries(scope: scope).first(where: { $0.record.id == value.id })?.notes ?? value.notes
                    pendingSaves.removeValue(forKey: value.id)
                }
                setEditor(value, notes: action == .save || latestNotes != record.notes ? latestNotes : value.notes)
                rememberDraft()
                if let index = meetings.firstIndex(where: { $0.id == value.id }) { meetings[index] = value }
            } else {
                let (scope, journal) = try writableJournal()
                try journal.remove(id: record.id, scope: scope)
                pendingSaves.removeValue(forKey: record.id); drafts.removeValue(forKey: record.id)
                meetings.removeAll { $0.id == record.id }; setEditor(nil, notes: ""); selectedID = nil
            }
        } catch {
            guard epoch == generation, selectionEpoch == selection, !Task.isCancelled else { return }
            if action == .save, let submission, let failure = error as? APIError,
               [APIError.http(400), .http(413), .http(415), .http(422)].contains(failure) {
                do {
                    let (scope, journal) = try writableJournal()
                    try journal.reject(submission, scope: scope)
                    pendingSaves.removeValue(forKey: record.id)
                    rememberDraft()
                    detailError = "This save was rejected. Your notes are preserved; correct the draft and save again."
                } catch { detailError = error.localizedDescription }
            } else if error as? APIError == .http(409) {
                detailError = "This recording changed on another device. Your draft is preserved. Save a copy before reloading the latest version."
            } else if action == .summarize, error as? APIError == .http(413) {
                detailError = "This recording is too large to summarize in full. No transcript was omitted or changed. Your complete transcript and notes remain available."
            } else if error as? APIError == .http(410) || error as? APIError == .http(404) {
                detailError = "This recording was deleted on another device. Your unsaved notes are still here; copy them before leaving this account."
            } else { detailError = error.localizedDescription }
        }
    }
}

struct MeetingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var library: MacMeetingLibrary
    @State private var deleteConfirmation = false
    @State private var discardSelection: UUID?
    @State private var discardConfirmation = false
    @State private var tab = "Notes"
    @State private var visible = false

    var body: some View {
        HSplitView {
            list.frame(minWidth: 240, idealWidth: 290, maxWidth: 380)
            detail.frame(minWidth: 300, maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: model.state.accountScope) {
            visible = true
            await refreshVisible()
        }
        .onDisappear { visible = false; library.suspend() }
        .onChange(of: model.state.accountScope) { _, _ in
            deleteConfirmation = false; discardConfirmation = false; discardSelection = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshVisible() } }
            else { library.suspend() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refreshVisible() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in library.suspend() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didMiniaturizeNotification)) { _ in
            if !NSApp.windows.contains(where: { $0.isVisible && !$0.isMiniaturized && $0.canBecomeMain }) { library.suspend() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.willCloseNotification)) { notification in
            guard let closing = notification.object as? NSWindow, closing.canBecomeMain else { return }
            if !NSApp.windows.contains(where: { $0 !== closing && $0.isVisible && !$0.isMiniaturized && $0.canBecomeMain }) { library.suspend() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didDeminiaturizeNotification)) { _ in
            Task { await refreshVisible() }
        }
        .confirmationDialog("Delete this recording?", isPresented: $deleteConfirmation, titleVisibility: .visible) {
            Button("Delete recording", role: .destructive) { Task { await library.perform(.delete) } }
        } message: { Text("The transcript, your notes, and generated summary will be removed from your account. This cannot be undone.") }
        .confirmationDialog("Discard unsaved notes?", isPresented: $discardConfirmation, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) {
                if let id = discardSelection { Task { await library.select(id, discardDraft: true) } }
            }
        } message: { Text("Reloading replaces this recording’s unsaved notes. Save or copy them first.") }
        .accessibilityIdentifier("meetings-page")
    }
    private func refreshVisible() async {
        guard visible, NSApp.isActive, model.state.connected,
              NSApp.windows.contains(where: { $0.isVisible && !$0.isMiniaturized && $0.canBecomeMain }) else { return }
        library.client = { [weak model] in
            guard let model else { throw APIError.invalidCredential }
            return try model.meetingsClient()
        }
        // Revalidate details without overwriting a draft; the library fences
        // the whole refresh to one account generation.
        await library.refresh()
    }
    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Meetings", systemImage: "waveform").font(.title3.weight(.semibold))
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await refreshVisible() } }
                    .labelStyle(.iconOnly).disabled(library.loading || library.busy).accessibilityIdentifier("meetings-refresh")
            }.padding(18)
            TextField("Search recording titles", text: $library.query).textFieldStyle(.roundedBorder)
                .padding(.horizontal, 16).padding(.bottom, 12).accessibilityIdentifier("meetings-search")
            Text("Synced across your account").font(.caption).foregroundStyle(.secondary).padding(.horizontal, 18).padding(.bottom, 10)
            Divider()
            if !model.state.connected {
                ContentUnavailableView("Sign in to view meetings", systemImage: "person.crop.circle", description: Text("Connect your Nanocodex account in Settings."))
            } else if library.loading && library.meetings.isEmpty {
                ProgressView("Loading recordings…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if library.meetings.isEmpty, let error = library.error {
                failure(error) { Task { await library.load() } }
            } else if library.meetings.isEmpty {
                ContentUnavailableView("No recordings yet", systemImage: "waveform", description: Text("Record a meeting on your iPhone. Its saved transcript and notes appear here."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(library.filtered) { item in
                            Button {
                                Task { await library.select(item.id) }
                            } label: { row(item) }.buttonStyle(.plain).disabled(library.busy)
                                .accessibilityIdentifier("meeting-row-" + item.id.uuidString.lowercased())
                        }
                        if library.filtered.isEmpty { ContentUnavailableView.search(text: library.query) }
                        if let error = library.error { failure(error) { Task { await library.retryLoad() } } }
                        if library.nextCursor != nil {
                            Button(library.loading ? "Loading…" : "Load more recordings") { Task { await library.load(more: true) } }.disabled(library.loading)
                        }
                    }.padding(10)
                }
            }
        }
    }
    private func row(_ item: MeetingRecord) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.title.isEmpty ? "Untitled meeting" : item.title).font(.headline).lineLimit(2)
            Text(date(item.startedAt)).font(.caption).foregroundStyle(.secondary)
            HStack {
                Label(duration(item.durationSeconds), systemImage: "clock")
                if item.partial { Label("Partial", systemImage: "exclamationmark.circle") }
            }.font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Color.primary.opacity(library.selectedID == item.id ? 0.08 : 0.025), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(library.selectedID == item.id ? Color.accentColor.opacity(0.5) : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 12))
    }
    @ViewBuilder private var detail: some View {
        if library.detailLoading { ProgressView("Loading recording…").frame(maxWidth: .infinity, maxHeight: .infinity) }
        else if let record = library.record {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(record.title.isEmpty ? "Untitled meeting" : record.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                        Text("\(date(record.startedAt)) · \(duration(record.durationSeconds))" ).font(.caption).foregroundStyle(.secondary)
                        if record.partial { Label("Partial recording · capture ended early", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button("Delete", systemImage: "trash") { deleteConfirmation = true }.disabled(library.busy).accessibilityIdentifier("meeting-delete")
                }
                Picker("Recording content", selection: $tab) { Text("Notes").tag("Notes"); Text("Transcript").tag("Transcript") }.pickerStyle(.segmented).accessibilityIdentifier("meeting-content-picker")
                if let error = library.detailError {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(error).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        Button("Reload latest version") { discardSelection = record.id; if library.canSave { discardConfirmation = true } else { Task { await library.select(record.id) } } }
                    }.padding(12).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                }
                if tab == "Notes" {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            HStack {
                                Label("Generated summary", systemImage: "sparkles").font(.headline)
                                Spacer()
                                Button(library.busy ? "Working…" : record.summaryStatus == .unavailable ? "Retry summary" : record.summary.isEmpty ? "Summarize" : "Refresh enhanced notes") { Task { await library.perform(.summarize) } }
                                    .disabled(library.busy || library.canSave || (record.transcript.isEmpty && record.notes.isEmpty)).accessibilityIdentifier("meeting-summarize")
                            }
                            if record.summary.isEmpty {
                                Text(record.summaryStatus == .unavailable ? "Summary unavailable. Your transcript and notes are safe. Try Retry summary when the service is available." : "Create a summary from the saved transcript.")
                                    .foregroundStyle(.secondary)
                            } else { ChatMarkdown(text: record.summary).textSelection(.enabled) }
                            Text("AI-generated from the transcript. Verify important details.").font(.caption).foregroundStyle(.secondary)
                            Divider()
                            HStack {
                                Label("Your notes", systemImage: "square.and.pencil").font(.headline)
                                Spacer()
                                Button(library.hasPendingSave ? "Retry sync" : "Save notes") { Task { await library.perform(.save) } }.disabled(!library.canSave || library.busy).accessibilityIdentifier("meeting-save-notes")
                            }
                            TextEditor(text: $library.notes).font(.body).frame(minHeight: 160).disabled(library.busy)
                                .accessibilityLabel("Your meeting notes").accessibilityIdentifier("meeting-notes-editor")
                            Text(library.canSave ? "Unsaved notes stay here when you switch recordings or leave Meetings. Save to sync across devices." : "Your notes are separate from the generated summary.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Saved transcript").font(.headline)
                            Text(record.transcript.isEmpty ? "No speech was captured." : record.transcript).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            Text("Audio is not stored. Playback is unavailable.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.accessibilityIdentifier("meeting-transcript")
                }
            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else if let error = library.detailError, let id = library.selectedID { failure(error) { Task { await library.select(id) } } }
        else { ContentUnavailableView("Select a recording", systemImage: "waveform", description: Text("Review your meeting notes, summary, and transcript.")) }
    }
    private func failure(_ message: String, retry: @escaping () -> Void) -> some View {
        VStack(spacing: 12) { Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center); Button("Retry", action: retry) }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func date(_ value: Date) -> String { value.formatted(date: .abbreviated, time: .shortened) }
    private func duration(_ seconds: Int) -> String { let minutes = Int(max(0, seconds)) / 60; return minutes < 1 ? "Under a minute" : "\(minutes) min" }
}

#if DEBUG
/// Only the native UI fixture installs this adapter. Keep production HTTPS
/// validation intact while exercising the actual account HTTP router locally.
final class NativeMeetingsHTTPFixture: URLProtocol, URLSessionTaskDelegate, @unchecked Sendable {
    static let credential = try! AccountCredential(origin: "https://native-meetings-fixture.invalid",
        apiKey: "ncx_live_abcdefgh1234_" + String(repeating: "x", count: 43))
    static func makeClient() -> ManagedClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeMeetingsHTTPFixture.self]
        return ManagedClient(credential: credential, configuration: configuration)
    }
    private static let faultLock = NSLock()
    private static var droppedSave = false
    private static func dropSaveResponse(_ method: String?) -> Bool {
        guard method == "PUT", ProcessInfo.processInfo.environment["NANOCODEX_NATIVE_MEETINGS_DROP_SAVE_RESPONSE"] == "1" else { return false }
        faultLock.lock(); defer { faultLock.unlock() }
        guard !droppedSave else { return false }; droppedSave = true; return true
    }
    private var session: URLSession?
    private var forwardedTask: URLSessionDataTask?
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "native-meetings-fixture.invalid"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let original = request.url,
              original.path == "/v1/meetings" || original.path.hasPrefix("/v1/meetings/"),
              var url = URLComponents(url: original, resolvingAgainstBaseURL: false) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        url.scheme = "http"; url.host = "127.0.0.1"; url.port = 8797
        var forwarded = request; forwarded.url = url.url
        if forwarded.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var body = Data(), buffer = [UInt8](repeating: 0, count: 8192)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count >= 0, body.count + count <= 2 * 1024 * 1024 else {
                    client?.urlProtocol(self, didFailWithError: URLError(.dataLengthExceedsMaximum)); return
                }
                if count == 0 { break }; body.append(buffer, count: count)
            }
            forwarded.httpBodyStream = nil; forwarded.httpBody = body
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = []
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: forwarded) { [weak self] data, response, error in
            guard let self else { return }
            self.lock.lock(); let stopped = self.stopped; self.lock.unlock()
            defer { session.finishTasksAndInvalidate() }
            guard !stopped else { return }
            if let error { self.client?.urlProtocol(self, didFailWithError: error); return }
            guard let response else { self.client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return }
            // Inject only a transport failure after the real backend accepted
            // the PUT. Native retry still sends actual HTTP to the router/D1.
            if (response as? HTTPURLResponse)?.statusCode == 200, Self.dropSaveResponse(self.request.httpMethod) {
                self.client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return
            }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if let data { self.client?.urlProtocol(self, didLoad: data) }
            self.client?.urlProtocolDidFinishLoading(self)
        }
        self.forwardedTask = task; task.resume()
    }
    override func stopLoading() {
        lock.lock(); stopped = true; lock.unlock()
        forwardedTask?.cancel(); session?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
#endif
