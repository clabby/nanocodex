import XCTest
import InboxCore
import NanocodexHand
import NanocodexApps

final class AppValidationTests: XCTestCase {
    func testPublicHandValidationUsesIsolatedStateAndReturnsNativeDiagnostics() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("app-preflight-" + UUID().uuidString)
        let hand = try HandWorkspace(id: "preflight-journey", name: "Preflight journey", root: root, platform: "macos")
        defer { try? FileManager.default.removeItem(at: root) }
        let sentinel = root.appendingPathComponent("production-state.json")
        let bytes = Data("{\"count\":999}".utf8)
        try bytes.write(to: sentinel)
        let catalog = hand.catalog
        XCTAssertTrue(catalog["tools"].array.contains { $0["remote_name"].string == "validate_app" })
        let source = """
        struct App: View {
            @Persisted("count") var count = 0
            var body: some View { VStack { Text("Count: \\(count)"); Button("Add") { count += 1 } } }
        }
        """
        let result = try await hand.call(name: "validate_app", input: .object([
            "runtime": .string("swift-v1"), "source": .string(source), "state": .object(["count": .number(4)]),
            "steps": .array([.object(["action": .string("tap"), "title": .string("Add")]),
                .object(["action": .string("reopen")]),
                .object(["action": .string("expect"), "text": .string("Count: 5")])])
        ]))
        XCTAssertEqual(result["valid"], .bool(true))
        XCTAssertEqual(result["stage"], .string("complete"))
        XCTAssertEqual(result["persisted_test_state"]["count"], .number(5))
        XCTAssertEqual(result["source_sha256"].string.count, 64)
        XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["production-state.json"])
        let broken = try await hand.call(name: "validate_app", input: .object([
            "runtime": .string("swift-v1"), "source": .string("struct Record { var id = \"x\" }\n" + source)
        ]))
        XCTAssertEqual(broken["valid"], .bool(false))
        XCTAssertEqual(broken["stage"], .string("parse"))
        XCTAssertEqual(broken["diagnostic"]["line"], .number(1))
        print("PASS public Hand validate_app: isolated 4 -> 5 -> reopen, SHA-256, record diagnostic line 1, production sentinel unchanged; no additional files")
    }

    @MainActor
    func testPublicPreflightCancellationStopsInterpretedJourney() async throws {
        let source = """
        struct App: View {
            @State var value = 0
            var body: some View { Button("Spin") { while true { value += 1 } } }
        }
        """
        let json = try JSONEncoder().encode(JSON.object([
            "runtime": .string("swift-v1"), "source": .string(source),
            "steps": .array([.object(["action": .string("tap"), "title": .string("Spin")])])
        ]))
        let validation = Task { await NativeAppPreflight.validate(json: json) }
        // The interpreter yields during work; cancelling the task must preserve its cancellation contract.
        await Task.yield()
        validation.cancel()
        let result = await validation.value
        XCTAssertFalse(result.valid)
        XCTAssertTrue(result.diagnostic?.message.lowercased().contains("cancel") == true)
        XCTAssertEqual(result.persisted_test_state, [:])
        print("PASS public preflight cancellation: \(result.stage), \(result.diagnostic?.message ?? "missing diagnostic")")
    }
}
