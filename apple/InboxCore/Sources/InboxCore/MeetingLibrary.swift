import Combine
import Foundation

public enum MeetingSummaryStatus: String, Codable, Sendable { case none, ready, unavailable }

/// A transcript and notes document. Microphone audio is not retained or playable.
public struct MeetingRecord: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var title: String
    public var startedAt: Date
    public var updatedAt: Date
    public var durationSeconds: Int
    public var transcript: String
    public var notes: String
    public var partial: Bool
    public var revision: Int
    public var summary: String
    public var summaryStatus: MeetingSummaryStatus
    public init(id: UUID = UUID(), title: String = "Meeting", startedAt: Date = Date(), updatedAt: Date = Date(), durationSeconds: Int = 0, transcript: String = "", notes: String = "", partial: Bool = false, revision: Int = 1, summary: String = "", summaryStatus: MeetingSummaryStatus = .none) {
        self.id = id; self.title = title; self.startedAt = startedAt; self.updatedAt = updatedAt
        self.durationSeconds = durationSeconds; self.transcript = transcript; self.notes = notes
        self.partial = partial; self.revision = revision; self.summary = summary; self.summaryStatus = summaryStatus
    }
    public init(_ json: JSON) throws {
        guard case .number(let revision) = json["revision"], case .number(let duration) = json["duration_seconds"],
              revision.isFinite, revision.rounded(.towardZero) == revision, (1...9_007_199_254_740_991).contains(revision),
              duration.isFinite, duration.rounded(.towardZero) == duration, (0...9_007_199_254_740_991).contains(duration),
              let id = UUID(uuidString: json["id"].string),
              let started = Self.date(json["started_at"].string), let updated = Self.date(json["updated_at"].string),
              let status = MeetingSummaryStatus(rawValue: json["summary_status"].string) else { throw APIError.invalidResponse }
        self.init(id: id, title: json["title"].string, startedAt: started, updatedAt: updated,
                  durationSeconds: Int(duration), transcript: json["transcript"].string,
                  notes: json["notes"].string, partial: json["partial"].bool, revision: Int(revision),
                  summary: json["summary"].string, summaryStatus: status)
    }
    private static func date(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
    // Compare local checkpoints at the exact timestamp precision carried over
    // HTTP. An acknowledgement must not turn the same capture into an edit just
    // because its original Date included subsecond values.
    var uploadStartedAt: String { ISO8601DateFormatter().string(from: startedAt) }
    public var uploadBody: JSON {
        .object(["revision": .number(Double(revision)), "title": .string(title),
                 "started_at": .string(uploadStartedAt),
                 "duration_seconds": .number(Double(durationSeconds)), "transcript": .string(transcript),
                 "notes": .string(notes), "partial": .bool(partial)])
    }
}

public struct MeetingPage: Sendable {
    public let meetings: [MeetingRecord]
    public let nextCursor: String?
    public init(_ json: JSON) throws {
        guard case .array(let rows) = json["meetings"] else { throw APIError.invalidResponse }
        meetings = try rows.map(MeetingRecord.init)
        nextCursor = json["next_cursor"].string.isEmpty ? nil : json["next_cursor"].string
    }
}

/// Durable account-scoped cache/outbox, independent of agent threads. Every local
/// edit commits before a request. An ambiguous write retries the same ID/revision.
@MainActor
public final class MeetingLibrary: ObservableObject {
    @Published public private(set) var entries: [MeetingRecordingStore.Entry] = []
    @Published public private(set) var error: String?
    @Published public private(set) var loading = false
    @Published public private(set) var nextCursor: String?
    public private(set) var scope: String?
    private let store: MeetingRecordingStore
    private var client: ManagedClient?
    private var epoch = UUID()
    private var flushing = false
    private var retryRequested = false
    public init(store: MeetingRecordingStore) { self.store = store }

    public func activate(scope: String?, client: ManagedClient?, activeCaptureID: UUID? = nil) {
        epoch = UUID(); self.scope = scope; self.client = client; entries = []; error = nil; loading = false; flushing = false; retryRequested = false; nextCursor = nil
        guard let scope else { return }
        do {
            try store.recover(scope: scope, excluding: activeCaptureID)
            entries = try store.entries(scope: scope)
        } catch { self.error = error.localizedDescription }
    }
    public func reloadLocal() {
        guard let scope else { return }
        do { entries = try store.entries(scope: scope) } catch { self.error = error.localizedDescription }
    }
    public func refresh(loadMore: Bool = false) async {
        guard let scope, let client, !loading else { return }
        let token = epoch; loading = true; error = nil
        defer { if epoch == token { loading = false } }
        do {
            let page = try await client.meetings(cursor: loadMore ? nextCursor : nil)
            guard epoch == token, self.scope == scope else { return }
            for record in page.meetings { try store.merge(record, scope: scope, detailsLoaded: false) }
            if !loadMore {
                let listed = Set(page.meetings.map(\.id))
                // Absence from one page is not deletion. Confirm against the real
                // document endpoint before hiding any cached synced document.
                for entry in try store.entries(scope: scope) where entry.state == .synced && !listed.contains(entry.id) {
                    do {
                        let remote = try await client.meeting(id: entry.id)
                        guard epoch == token else { return }
                        try store.merge(remote, scope: scope, detailsLoaded: true)
                    } catch APIError.http(404) {
                        guard epoch == token else { return }
                        try store.removeDeleted(id: entry.id, scope: scope)
                    }
                }
            }
            nextCursor = page.nextCursor; reloadLocal()
            await retry()
        } catch { if epoch == token { self.error = error.localizedDescription } }
    }
    public func detail(id: UUID) async throws -> MeetingRecord {
        guard let scope else { throw APIError.invalidCredential }
        if let entry = try store.entries(scope: scope).first(where: { $0.id == id }), entry.detailsLoaded, entry.state != .synced || client == nil { return entry.record }
        guard let client else { throw APIError.invalidCredential }
        let token = epoch
        let record: MeetingRecord
        do { record = try await client.meeting(id: id) }
        catch APIError.http(404) {
            guard epoch == token else { throw APIError.invalidCredential }
            try store.removeDeleted(id: id, scope: scope); reloadLocal()
            throw APIError.http(404)
        }
        guard epoch == token, self.scope == scope else { throw APIError.invalidCredential }
        try store.merge(record, scope: scope, detailsLoaded: true); reloadLocal()
        return try store.entries(scope: scope).first(where: { $0.id == id })?.record ?? record
    }
    public func save(_ record: MeetingRecord) async throws {
        guard let scope else { throw APIError.invalidCredential }
        try store.put(record, scope: scope, state: .pending); reloadLocal()
        await retry()
    }
    public func delete(id: UUID) async throws {
        guard let scope else { throw APIError.invalidCredential }
        try store.markDeleted(id: id, scope: scope); reloadLocal()
        await retry()
    }
    /// Explicit user choice: discard local edits and load the current cloud
    /// document. Callers should offer copying the local draft before this action.
    public func reloadServer(id: UUID) async throws -> MeetingRecord {
        try await resolveConflict(id: id, keepLocal: false)
    }
    /// Explicit user choice: keep the local document over the current cloud copy.
    public func chooseKeepLocal(id: UUID) async throws {
        _ = try await resolveConflict(id: id, keepLocal: true)
    }
    public func resolveConflict(id: UUID, keepLocal: Bool) async throws -> MeetingRecord {
        guard let scope, let client else { throw APIError.invalidCredential }
        let token = epoch
        let remote = try await client.meeting(id: id)
        guard epoch == token, self.scope == scope else { throw APIError.invalidCredential }
        try store.resolveConflict(remote, scope: scope, keepLocal: keepLocal); reloadLocal()
        if keepLocal { await retry() }
        guard epoch == token, self.scope == scope else { throw APIError.invalidCredential }
        return try store.entries(scope: scope).first(where: { $0.id == id })?.record ?? remote
    }
    public func summarize(id: UUID) async throws {
        guard let scope, let client else { throw APIError.invalidCredential }
        let token = epoch
        await retry()
        guard token == epoch, self.scope == scope else { throw APIError.invalidCredential }
        guard let entry = try store.entries(scope: scope).first(where: { $0.id == id }), entry.state == .synced else { throw APIError.invalidResponse }
        // Successful summaries are immutable for this document revision; a
        // Refresh reuses the cached result without rewriting meeting content.
        let record = try await client.summarizeMeeting(id: id, revision: entry.record.revision)
        guard token == epoch, self.scope == scope else { throw APIError.invalidCredential }
        try store.merge(record, scope: scope, detailsLoaded: true); reloadLocal()
    }
    public func retry() async {
        guard let scope, let client else { return }
        if flushing { retryRequested = true; return }
        let token = epoch; flushing = true; error = nil
        defer {
            if epoch == token {
                flushing = false; reloadLocal()
                if entries.contains(where: { $0.state == .conflicted }), error == nil {
                    error = "A meeting changed on another device. Your local draft and the cloud copy are both preserved. Open it to choose which version to keep."
                }
                if retryRequested {
                    retryRequested = false
                    // A save of another UUID during this flush was not in its
                    // original snapshot. Drain it without waiting for refresh.
                    Task { [weak self] in
                        guard let self, self.epoch == token else { return }
                        await self.retry()
                    }
                }
            }
        }
        do {
            for entry in try store.entries(scope: scope, includeDeleted: true) where entry.state == .pending || entry.state == .deleting {
                guard token == epoch else { return }
                if entry.state == .deleting {
                    try await client.deleteMeeting(id: entry.id)
                    guard token == epoch else { return }
                    try store.removeDeleted(id: entry.id, scope: scope)
                } else {
                    // Drain a coalesced edit after acknowledging the previous immutable
                    // attempt. Bound concurrent edits so a busy capture never starves UI.
                    uploadLoop: for _ in 0..<8 {
                        guard token == epoch, let attempted = try store.prepareUpload(id: entry.id, scope: scope) else { break }
                        do {
                            let expected = try store.uploadPrecondition(id: entry.id, scope: scope, revision: attempted.revision)
                            let result = try await client.saveMeeting(attempted, ifMatch: expected)
                            guard token == epoch else { return }
                            try store.acknowledge(result, scope: scope, revision: attempted.revision)
                        } catch APIError.http(409) {
                            do {
                                let remote = try await client.meeting(id: entry.id)
                                guard token == epoch else { return }
                                try store.reconcileConflict(remote, scope: scope)
                            } catch APIError.http(404) {
                                guard token == epoch else { return }
                                try store.removeDeleted(id: entry.id, scope: scope)
                            }
                        } catch APIError.http(410) {
                            guard token == epoch else { return }
                            try store.removeDeleted(id: entry.id, scope: scope)
                        } catch APIError.http(let code) where [400, 413, 415, 422].contains(code) {
                            guard token == epoch else { return }
                            try store.rejectUpload(id: entry.id, scope: scope, revision: attempted.revision)
                            self.error = "Meeting \"" + String(attempted.title.prefix(60)) + "\" could not sync because its title, transcript or notes are invalid or too large (\(code)). Edit it to retry. Other meetings will continue syncing."
                            // Definitive non-admission is local to this document.
                            // Leave it editable, but do not starve later UUIDs or
                            // spend all eight retries resending invalid content.
                            break uploadLoop
                        }
                    }
                }
            }
        } catch { if token == epoch { self.error = error.localizedDescription } }
    }
}
