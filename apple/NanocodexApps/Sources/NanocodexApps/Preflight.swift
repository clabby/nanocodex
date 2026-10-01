import Foundation
import CryptoKit

/// Isolated, bounded execution through the same parser and interpreter as NativeAppView.
/// A successful result covers only the supplied journey, not every possible user action.
public enum NativeAppPreflight {
    public static let maximumInputBytes = 1_048_576
    public static let maximumOutputBytes = 524_288

    public struct Check: Codable, Sendable {
        public var stage: String
        public var passed: Bool
        public var step: Int?
    }
    public struct Result: Codable, Sendable {
        public var valid = false
        public var runtime = "swift-v1"
        public var source_sha256 = ""
        public var stage = "input"
        public var diagnostic: AppDiagnostic?
        public var checks: [Check] = []
        public var rendered_tree: [AppNode] = []
        public var reopened_tree: [AppNode] = []
        public var persisted_test_state: [String: AppValue] = [:]
        public var tree_only = true
        public var output_truncated = false
        public var agent_fixture_calls = 0
    }

    /// Accepts the same JSON used by the Hand validate_app tool and --validate-json CLI.
    /// No account, disk, network, or production host is used, including for Agent.run.
    @MainActor
    public static func validate(json: Data) async -> Result {
        var result = Result()
        var memory: MemoryHost?
        var session: NativeAppSession?
        var stepIndex: Int?
        defer { session?.invalidate() }
        func check(_ stage: String, step: Int? = nil) {
            result.checks.append(Check(stage: stage, passed: true, step: step))
        }
        do {
            guard json.count <= maximumInputBytes else { throw AppDiagnostic("Validation input exceeds 1 MiB.") }
            let request = try JSONDecoder().decode([String: AppValue].self, from: json)
            if case .string(let source) = request["source"] {
                result.source_sha256 = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
            }
            guard Set(request.keys).isSubset(of: ["runtime", "source", "state", "steps", "agent_response"]),
                  request["runtime"] == .string("swift-v1"), case .string(let source) = request["source"] else {
                throw AppDiagnostic("Supply runtime=swift-v1 and source; optional fields are state, steps, agent_response.")
            }
            guard source.utf8.count <= 262_144 else { throw AppDiagnostic("Source exceeds the 256 KiB limit.") }
            let state: [String: AppValue]
            if let value = request["state"] {
                guard case .object(let object) = value else { throw AppDiagnostic("state must be a JSON object.") }
                state = object
            } else { state = [:] }
            try validateState(state)
            let steps: [AppValue]
            if let value = request["steps"] {
                guard case .array(let array) = value, array.count <= 32 else { throw AppDiagnostic("steps must be an array of at most 32 actions.") }
                steps = array
            } else { steps = [] }
            let response: String?
            if let value = request["agent_response"] {
                guard case .string(let text) = value, text.utf8.count <= 262_144 else { throw AppDiagnostic("agent_response must be a string of at most 256 KiB.") }
                response = text
            } else { response = nil }
            // Validate every action before executing any journey work.
            for step in steps { try validateStep(step) }
            check("input")
            try Task.checkCancellation()
            let host = MemoryHost(state: state, response: response)
            memory = host
            result.stage = "parse"
            session = try NativeAppSession(source: source, host: host.host())
            check("parse")
            result.stage = "initialize_render"
            try await session!.start()
            check("initialize_render")
            for (index, step) in steps.enumerated() {
                stepIndex = index
                try Task.checkCancellation()
                guard case .object(let fields) = step, case .string(let action) = fields["action"] else { throw AppDiagnostic("Invalid step.") }
                result.stage = action
                let active = session!
                let controls = flatten(active.nodes)
                switch action {
                case "tap":
                    let title = fields["title"]!.text
                    let matches = controls.filter { $0.kind == "Button" && ($0.text == title || $0.properties["title"]?.text == title || $0.properties["label"]?.text == title) }
                    guard matches.count == 1, let button = matches.first, let id = button.actionID else {
                        throw AppDiagnostic("Expected one actionable button titled '\(title)'; found \(matches.count).")
                    }
                    guard !disabled(id: button.id, in: active.nodes) else { throw AppDiagnostic("Button '\(title)' is disabled.") }
                    await active.perform(actionID: id)
                case "set":
                    let binding = fields["binding"]!.text
                    let matches = controls.filter { $0.binding == binding }
                    guard !matches.isEmpty, active.state[binding] != nil else { throw AppDiagnostic("No rendered control binds to '\(binding)'.") }
                    guard matches.contains(where: { !disabled(id: $0.id, in: active.nodes) }) else { throw AppDiagnostic("Binding '\(binding)' is disabled.") }
                    await active.setBinding(binding, value: fields["value"]!)
                case "expect":
                    let text = fields["text"]!.text
                    guard controls.contains(where: { $0.kind == "Text" && $0.text == text }) else { throw AppDiagnostic("Expected rendered Text '\(text)'.") }
                case "reopen":
                    active.invalidate()
                    session = try NativeAppSession(source: source, host: host.host())
                    try await session!.start()
                default: throw AppDiagnostic("Unsupported step.")
                }
                if let diagnostic = session!.diagnostic { throw diagnostic }
                check(action, step: index)
            }
            stepIndex = nil
            result.rendered_tree = session!.nodes
            result.stage = "reopen"
            session!.invalidate()
            session = try NativeAppSession(source: source, host: host.host())
            try await session!.start()
            result.reopened_tree = session!.nodes
            check("reopen")
            try Task.checkCancellation()
            result.stage = "complete"
            result.valid = true
        } catch {
            let diagnostic = error as? AppDiagnostic ?? AppDiagnostic(error is CancellationError ? "Validation cancelled." : error.localizedDescription)
            result.diagnostic = AppDiagnostic(String(diagnostic.message.prefix(4_096)), line: diagnostic.line)
            result.checks.append(Check(stage: result.stage, passed: false, step: stepIndex))
            if result.rendered_tree.isEmpty { result.rendered_tree = session?.nodes ?? [] }
        }
        result.persisted_test_state = memory?.state ?? [:]
        result.agent_fixture_calls = memory?.fixtureCalls ?? 0
        var treeBudget = 163_840
        func boundedTree(_ nodes: [AppNode]) -> [AppNode] {
            var output: [AppNode] = []
            for node in nodes {
                var copy = node
                copy.children = []
                let size = (try? JSONEncoder().encode(copy).count) ?? Int.max
                guard size <= treeBudget else { result.output_truncated = true; continue }
                treeBudget -= size
                copy.children = boundedTree(node.children)
                output.append(copy)
            }
            return output
        }
        result.rendered_tree = boundedTree(result.rendered_tree)
        result.reopened_tree = boundedTree(result.reopened_tree)
        // Preserve diagnostics and exact saved test state when tree size exhausts the output budget.
        // No screenshot is claimed: these are interpreter trees, not rendered pixels.
        if (try? JSONEncoder().encode(result).count) ?? Int.max > maximumOutputBytes {
            result.rendered_tree = []; result.reopened_tree = []; result.output_truncated = true
        }
        return result
    }

    private static func validateStep(_ step: AppValue) throws {
        guard case .object(let fields) = step, case .string(let action) = fields["action"] else { throw AppDiagnostic("Each step requires an action.") }
        let expected: Set<String>
        switch action {
        case "tap": expected = ["action", "title"]
        case "set": expected = ["action", "binding", "value"]
        case "expect": expected = ["action", "text"]
        case "reopen": expected = ["action"]
        default: throw AppDiagnostic("Unknown validation action '\(action)'.")
        }
        guard Set(fields.keys) == expected else { throw AppDiagnostic("Invalid fields for '\(action)' step.") }
        for key in expected.subtracting(["action", "value"]) {
            guard case .string(let text) = fields[key], text.utf8.count <= 4_096 else { throw AppDiagnostic("\(key) must be a string of at most 4096 bytes.") }
        }
        if let value = fields["value"] { try validateState(["value": value]) }
    }

    private static func validateState(_ state: [String: AppValue]) throws {
        guard try JSONEncoder().encode(state).count <= 262_144 else { throw AppDiagnostic("Test state exceeds the 256 KiB limit.") }
        func visit(_ value: AppValue, depth: Int) throws {
            guard depth <= 64 else { throw AppDiagnostic("Test state exceeds 64 nesting levels.") }
            switch value {
            case .object(let object):
                guard object.count <= 2_000 else { throw AppDiagnostic("Test state collection limit exceeded.") }
                for child in object.values { try visit(child, depth: depth + 1) }
            case .array(let array):
                guard array.count <= 2_000 else { throw AppDiagnostic("Test state collection limit exceeded.") }
                for child in array { try visit(child, depth: depth + 1) }
            default: break
            }
        }
        try visit(.object(state), depth: 0)
    }
    private static func flatten(_ nodes: [AppNode]) -> [AppNode] { nodes.flatMap { [$0] + flatten($0.children) } }
    private static func disabled(id: String, in nodes: [AppNode], inherited: Bool = false) -> Bool {
        for node in nodes {
            let value = inherited || node.properties["disabled"]?.truth == true
            if node.id == id { return value }
            if disabled(id: id, in: node.children, inherited: value) { return true }
        }
        return false
    }

    @MainActor
    private final class MemoryHost {
        var state: [String: AppValue]
        let response: String?
        var fixtureCalls = 0
        init(state: [String: AppValue], response: String?) { self.state = state; self.response = response }
        func host() -> NativeAppHost {
            NativeAppHost(loadState: { self.state }, saveState: { state in
                try validateState(state)
                self.state = state
            }, runAgent: { _ in
                guard let response = self.response else { throw AppDiagnostic("Agent.run is disabled during validation; supply agent_response for an explicit fixture.") }
                self.fixtureCalls += 1
                try Task.checkCancellation()
                return response
            }, agentRequestsHaveExternalEffects: false)
        }
    }
}
