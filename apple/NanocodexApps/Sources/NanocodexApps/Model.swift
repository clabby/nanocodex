import Foundation

public enum AppValue: Codable, Hashable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([AppValue]), object([String: AppValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode([AppValue].self) { self = .array(value) }
        else { self = .object(try c.decode([String: AppValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    public var text: String {
        switch self {
        case .null: return ""
        case .bool(let v): return String(v)
        case .number(let v): return v.rounded() == v && abs(v) < 1e16 ? String(format: "%.0f", v) : String(v)
        case .string(let v): return v
        case .array(let v): return v.map(\.text).joined(separator: ", ")
        case .object: return "Record"
        }
    }
    public var number: Double { if case .number(let n) = self { return n }; return Double(text) ?? 0 }
    public var truth: Bool { switch self { case .bool(let b): return b; case .null: return false; default: return number != 0 || !text.isEmpty && self != .number(0) } }
}

public struct AppDiagnostic: Error, LocalizedError, Equatable, Codable, Sendable {
    public let message: String
    public let line: Int
    public init(_ message: String, line: Int = 0) { self.message = message; self.line = line }
    public var errorDescription: String? { line > 0 ? "Line \(line): \(message)" : message }
}

indirect enum Expr {
    case value(AppValue), variable(String), binding(String), member(Expr, String), index(Expr, Expr)
    case array([Expr]), dictionary([(Expr, Expr)]), unary(String, Expr), binary(String, Expr, Expr)
    case call(Expr, [Argument], Closure?), conditional(Expr, Expr, Expr), interpolation([Expr]), awaitValue(Expr)
}
struct Argument { var label: String?; var value: Expr }
struct Closure { var parameters: [String]; var body: [Statement] }
indirect enum Statement {
    case expression(Expr), variable(String, Expr), assign(Expr, String, Expr), condition(Expr, [Statement], [Statement])
    case forEach(String, Expr, [Statement]), whileLoop(Expr, [Statement]), returnValue(Expr?)
}
struct StateDeclaration { var name: String; var initial: Expr; var persistedKey: String? }
struct FunctionDeclaration { var parameters: [String]; var body: [Statement] }
struct AppProgram {
    var states: [StateDeclaration] = []
    var constants: [String: Expr] = [:]
    var functions: [String: FunctionDeclaration] = [:]
    var records: [String: [String]] = [:]
    var body: [Statement] = []
}

public struct AppNode: Identifiable, Equatable, Codable, Sendable {
    public var id: String
    public var kind: String
    public var text: String
    public var properties: [String: AppValue]
    public var children: [AppNode]
    public var actionID: String?
    public var binding: String?
    public init(id: String, kind: String, text: String = "", properties: [String: AppValue] = [:], children: [AppNode] = [], actionID: String? = nil, binding: String? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.properties = properties; self.children = children; self.actionID = actionID; self.binding = binding
    }
}

public struct NativeAppHost {
    public var loadState: () async throws -> [String: AppValue]
    public var saveState: ([String: AppValue]) async throws -> Void
    public var runAgent: (String) async throws -> String
    /// False only for isolated fixture hosts that never dispatch external agent work.
    public var agentRequestsHaveExternalEffects: Bool
    /// The host can retain external-operation receipts until the enclosing action commits.
    public var beginAction: () -> Void
    public var commitAction: () -> Void
    public init(loadState: @escaping () async throws -> [String: AppValue], saveState: @escaping ([String: AppValue]) async throws -> Void, runAgent: @escaping (String) async throws -> String, agentRequestsHaveExternalEffects: Bool = true, beginAction: @escaping () -> Void = {}, commitAction: @escaping () -> Void = {}) {
        self.loadState = loadState; self.saveState = saveState; self.runAgent = runAgent
        self.agentRequestsHaveExternalEffects = agentRequestsHaveExternalEffects
        self.beginAction = beginAction; self.commitAction = commitAction
    }
}

public struct AppLimits: Sendable {
    public var steps: Int
    public var depth: Int
    public var nodes: Int
    public var collectionCount: Int
    public var agentCalls: Int
    public init(steps: Int = 500_000, depth: Int = 64, nodes: Int = 2_000, collectionCount: Int = 2_000, agentCalls: Int = 3) {
        self.steps = steps; self.depth = depth; self.nodes = nodes; self.collectionCount = collectionCount; self.agentCalls = agentCalls
    }
}
