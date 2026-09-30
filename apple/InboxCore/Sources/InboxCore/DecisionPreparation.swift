import Foundation

/// Missing preparation metadata is never interpreted as a prepared decision.
public enum TodoPreparationState: String, Sendable {
    case unprepared, pending, preparing, ready, blocked, failed, parked
    public var title: String {
        switch self { case .unprepared: return "Not prepared"; case .pending: return "Pending"; case .preparing: return "Preparing"; case .ready: return "Ready to review"; case .blocked: return "Blocked"; case .failed: return "Preparation failed"; case .parked: return "Parked" }
    }
    public init(serverValue: String) { self = Self(rawValue: serverValue) ?? .unprepared }
}

/// Approval is for the complete, persisted and visible version, not an ID alone.
public enum TodoDecisionApproval {
    /// Cached metadata can be rendered, but authority requires a fresh detail read.
    public static func matches(reviewed: TodoDecision, current: TodoDecision) -> Bool {
        reviewed.isPreparedForReview && current.isPreparedForReview && reviewed == current
    }
}

public enum TodoDraftApproval {
    public static func matches(reviewed: TodoMailDraft, current: TodoMailDraft?) -> Bool {
        guard let current, reviewed.version > 0, !reviewed.isLocked, !current.isLocked else { return false }
        return reviewed == current
    }
}

public extension TodoDecision {
    var isPreparedForReview: Bool {
        guard status == "needs_you", preparationState == .ready, !recommendation.isEmpty else { return false }
        if let draft = preparedDraft {
            return draft.version > 0 && !draft.isLocked && !draft.bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !draft.to.isEmpty && draft.to.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                && (draft.mode == .reply || draft.mode == .replyAll) && sourceMessageID != nil && sourceMessageID == draft.replyMessageID
                && sourceConnectionID == draft.connectionID
                && sourceThreadID == draft.threadID
        }
        // Email decisions cannot fall back to a textual proposal send control.
        return !proposal.isEmpty && (preparationKind == "action_review" || (sourceConnectionID == nil && sourceThreadID == nil))
    }
}

public struct TodoPreparationSource: Equatable, Sendable {
    public let kind: String
    public let reference: String
    public let detail: String
    public init(_ json: JSON) { kind = json["kind"].string; reference = json["reference"].string; detail = json["detail"].string }
}

public extension ManagedClient {
    func todoDecision(id: String) async throws -> TodoDecision {
        guard let target = UUID(uuidString: id) else { throw APIError.invalidResponse }
        return try TodoDecision(await json(path: "/v1/todo/decisions/\(target.uuidString.lowercased())")["decision"])
    }
    func prepareTodo(kind: String, id: String, version: Int, instructions: String, operationID: UUID) async throws {
        guard ["items", "decisions"].contains(kind), let target = UUID(uuidString: id), version > 0,
              !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError.invalidResponse }
        _ = try await json(path: "/v1/todo/\(kind)/\(target.uuidString.lowercased())/prepare", method: "POST", body: .object([
            "version": .number(Double(version)), "text": .string(instructions),
            "operation_id": .string(operationID.uuidString.lowercased())
        ]), idempotencyKey: operationID.uuidString.lowercased())
    }
}
