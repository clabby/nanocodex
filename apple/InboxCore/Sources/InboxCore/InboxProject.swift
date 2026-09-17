import Foundation

/// Device-local organization of persistent managed conversations.
public struct InboxProject: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var primaryAgentID: String
    public var agentIDs: [String]
    public init(id: String, name: String, primaryAgentID: String, agentIDs: [String]? = nil) {
        self.id = id; self.name = name; self.primaryAgentID = primaryAgentID
        self.agentIDs = agentIDs ?? [primaryAgentID]
    }
    public mutating func replaceAgent(_ old: String, with new: String) {
        if primaryAgentID == old { primaryAgentID = new }
        var seen = Set<String>()
        agentIDs = agentIDs.map { $0 == old ? new : $0 }.filter { seen.insert($0).inserted }
    }
}

/// A task is a real admitted turn, never an inferred split of the user's input.
public struct ProjectTask: Identifiable, Equatable, Sendable {
    public var id: String { agentID + ":" + turnID }
    public var agentID: String
    public var turnID: String
    public var title: String
    public var status: String
    public var rows: [TranscriptRow]
    public init(agentID: String, turnID: String, title: String, status: String, rows: [TranscriptRow]) {
        self.agentID = agentID; self.turnID = turnID; self.title = title; self.status = status; self.rows = rows
    }
    public var isLive: Bool { status == "Working" || status == "Queued" || status == "Sending" }

    public static func project(agentID: String, rows: [TranscriptRow], events: [AgentEvent], activeTurns: [String], pending: [PendingMessage]) -> [Self] {
        var order: [String] = []
        var grouped: [String: [TranscriptRow]] = [:]
        func admit(_ id: String) {
            guard !id.isEmpty, grouped[id] == nil else { return }
            order.append(id); grouped[id] = []
        }
        for row in rows {
            guard let id = row.turnID, !id.isEmpty else { continue }
            admit(id); grouped[id, default: []].append(row)
        }
        for id in activeTurns { admit(id) }
        let pending = pending.filter { $0.agentID == agentID }
        for message in pending { admit(message.id) }
        var outcomes: [String: String] = [:]
        for event in events {
            switch event.type {
            case "turn_completed": outcomes[event.turnID] = "Completed"
            case "turn_failed": outcomes[event.turnID] = "Failed"
            case "turn_cancelled": outcomes[event.turnID] = "Stopped"
            default: break
            }
        }
        return order.reversed().map { id in
            let content = grouped[id] ?? []
            let message = pending.first { $0.id == id }
            let input = content.first { $0.role == "You" }?.text ?? message?.input ?? ""
            let title = input
            let hasFinal = content.contains { $0.role == "Agent" && $0.phase == "final" && !$0.running }
            let status: String
            if let outcome = outcomes[id] { status = outcome }
            else if activeTurns.first == id { status = "Working" }
            else if activeTurns.contains(id) { status = "Queued" }
            else if let message { status = message.phase == .failed ? "Failed" : "Sending" }
            else { status = hasFinal ? "Completed" : "History" }
            return Self(agentID: agentID, turnID: id,
                        title: title.isEmpty ? "Task" : String(title.prefix(180)), status: status, rows: content)
        }
    }
}
