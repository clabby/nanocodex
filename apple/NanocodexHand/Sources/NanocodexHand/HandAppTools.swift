import Foundation
import InboxCore
import NanocodexApps

/// Validation never receives this Hand's filesystem or account host.
enum HandAppTools {
    static func catalog(_ tool: (String, String, [String: JSON], [String]) -> JSON) -> [JSON] {
        func string(_ description: String) -> JSON { .object(["type": .string("string"), "description": .string(description)]) }
        func step(_ properties: [String: JSON], required: [String]) -> JSON {
            .object(["type": .string("object"), "properties": .object(properties), "required": .array(required.map(JSON.string)), "additionalProperties": .bool(false)])
        }
        func action(_ name: String) -> JSON { .object(["type": .string("string"), "enum": .array([.string(name)])]) }
        return [tool("validate_app", "Preflight generated swift-v1 source with the exact native app parser and runtime. Uses isolated in-memory test state, initialization, supplied steps and persisted reopen. Returns SHA-256, diagnostic, checks and bounded interpreter trees (tree_only=true; no screenshot). No production storage or live Agent.run; agent_response is an explicit fixture. Success covers this journey, not all possible actions.", [
            "runtime": .object(["type": .string("string"), "enum": .array([.string("swift-v1")])]),
            "source": string("Complete Swift source, at most 256 KiB UTF-8."),
            "state": .object(["type": .string("object"), "description": .string("Optional persisted test state object; at most 256 KiB and 64 nesting levels.")]),
            "steps": .object(["type": .string("array"), "maxItems": .number(32), "items": .object(["oneOf": .array([
                step(["action": action("tap"), "title": string("Unique currently rendered button title.")], required: ["action", "title"]),
                step(["action": action("set"), "binding": string("Currently rendered binding name."), "value": .object([:])], required: ["action", "binding", "value"]),
                step(["action": action("expect"), "text": string("Exact rendered Text to assert.")], required: ["action", "text"]),
                step(["action": action("reopen")], required: ["action"])
            ])])]),
            "agent_response": string("Explicit fixture for Agent.run, at most 256 KiB; omitted means agent calls fail.")
        ], ["runtime", "source"])]
    }

    static func call(_ input: JSON) async throws -> JSON {
        let result = await NativeAppPreflight.validate(json: try JSONEncoder().encode(input))
        return try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(result))
    }
}
