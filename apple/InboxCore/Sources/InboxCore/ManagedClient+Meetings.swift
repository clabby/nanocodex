import Foundation

extension ManagedClient {
    public func meetings(cursor: String? = nil, limit: Int = 50) async throws -> MeetingPage {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "limit", value: String(max(1, min(100, limit))))]
        if let cursor { query.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try MeetingPage(await json(path: "/v1/meetings?" + (query.percentEncodedQuery ?? "")))
    }
    public func meeting(id: UUID) async throws -> MeetingRecord {
        let record = try MeetingRecord(await json(path: meetingPath(id))["meeting"])
        guard record.id == id else { throw APIError.invalidResponse }
        return record
    }
    public func saveMeeting(_ meeting: MeetingRecord, ifMatch: Int? = nil) async throws -> MeetingRecord {
        let record = try MeetingRecord(await json(path: meetingPath(meeting.id), method: "PUT", body: meeting.uploadBody, ifMatch: ifMatch)["meeting"])
        guard record.id == meeting.id, record.revision == meeting.revision else { throw APIError.invalidResponse }
        return record
    }
    public func deleteMeeting(id: UUID) async throws { _ = try await json(path: meetingPath(id), method: "DELETE") }
    public func summarizeMeeting(id: UUID, revision: Int) async throws -> MeetingRecord {
        let record = try MeetingRecord(await json(path: meetingPath(id) + "/summarize", method: "POST", body: .object(["revision": .number(Double(revision))]))["meeting"])
        guard record.id == id, record.revision == revision else { throw APIError.invalidResponse }
        return record
    }
    private func meetingPath(_ id: UUID) -> String { "/v1/meetings/" + id.uuidString.lowercased() }
}
