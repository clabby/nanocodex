import Foundation
import XCTest
@testable import InboxCore

/// The private HTTP boundary is exercised here; native view lifecycle and keyboard behavior
/// still require the iOS app journey, and are not simulated by these protocol checks.
final class BrowserNativeFormTests: XCTestCase {
    private let documentID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let usernameRef = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private let passwordRef = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    private let notesRef = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    private let codeRef = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

    private let countryRef = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    private let updatesRef = "11111111-1111-4111-8111-111111111111"

    private var nativeForm: [String: Any] {
        ["document_id": documentID, "reason": "Complete this profile", "fields": [
            ["ref": usernameRef, "label": "Email", "type": "email", "multiline": false, "autocomplete": "username", "inputmode": "email"],
            ["ref": passwordRef, "label": "Password", "type": "password", "multiline": false, "autocomplete": "current-password"],
            ["ref": notesRef, "label": "Notes", "type": "text", "multiline": true],
            ["ref": codeRef, "label": "Code", "type": "text", "multiline": false, "autocomplete": "one-time-code", "inputmode": "numeric"],
            ["ref": countryRef, "label": "Country", "type": "select", "multiline": false, "options": [["index": 0, "label": "Canada"], ["index": 2, "label": "Greece"]]],
            ["ref": updatesRef, "label": "Updates", "type": "checkbox", "multiline": false, "checked": true]
        ]]
    }
    private func response(form: [String: Any]?, login: Bool) throws -> String {
        var body: [String: Any] = ["status": "active", "image": "data:image/png;base64,iVBORw0KGgo=", "width": 390, "height": 700]
        if let form { body["native_form"] = form }
        if login { body["origin"] = "https://example.com" }
        return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    }
    private func intake(login: Bool) -> VaultIntake {
        .init(kind: "login", name: "", origin: "https://example.com",
              operation: login ? "browser_login" : "browser_takeover", vaultID: nil,
              challengeID: documentID, agentID: "agent_1",
              allowedOrigins: login ? ["https://example.com"] : nil)
    }

    func testPrivateLoginAndVaultDiscoverBatchFillThenReleaseExistingSession() async throws {
        for login in [true, false] {
            let discovery = try response(form: nativeForm, login: login)
            let viewport = try response(form: nil, login: login)
            let fixture = try HTTPFixture { request in
                XCTAssertEqual(request.method, "POST")
                XCTAssertEqual(request.path, "/v1/agents/agent_1/browser-vault/takeover")
                XCTAssertEqual(request.headers["cache-control"], "no-store")
                XCTAssertEqual(request.headers["authorization"], "Bearer \(fixtureKey)")
                XCTAssertEqual(request.json["challenge_id"] as? String, self.documentID)
                switch request.json["action"] as? String {
                case "observe":
                    XCTAssertEqual(request.json["native_fields"] as? Bool, true)
                    XCTAssertEqual(request.json["native_field_hints"] as? Bool, true)
                    XCTAssertEqual(request.json["native_field_controls"] as? Bool, true)
                    return FixtureReply(body: discovery)
                case "fill_fields":
                    XCTAssertEqual(Set(request.json.keys), Set(["action", "challenge_id", "document_id", "fields"]))
                    XCTAssertEqual(request.json["document_id"] as? String, self.documentID)
                    guard let fields = request.json["fields"] as? [[String: String]] else {
                        XCTFail("Missing native field batch")
                        return FixtureReply(status: 400, body: "{}")
                    }
                    XCTAssertEqual(fields, [
                        ["ref": self.usernameRef, "value": "synthetic@example.com"],
                        ["ref": self.passwordRef, "value": "synthetic-password"],
                        ["ref": self.notesRef, "value": "Synthetic line one\nLine two"],
                        ["ref": self.codeRef, "value": "123456"],
                        ["ref": self.countryRef, "value": "2"],
                        ["ref": self.updatesRef, "value": "false"]
                    ])
                    // The server remains active after fill: signing in requires another action.
                    return FixtureReply(body: viewport)
                case "finish":
                    XCTAssertEqual(Set(request.json.keys), Set(["action", "challenge_id"]))
                    return FixtureReply(body: login
                        ? "{\"type\":\"browser_login_receipt\",\"status\":\"finished\",\"request_id\":\"\(self.documentID)\"}"
                        : "{\"status\":\"finished\"}")
                default:
                    XCTFail("Unexpected automatic action")
                    return FixtureReply(status: 400, body: "{}")
                }
            }
            defer { fixture.close() }
            let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
            defer { client.close() }
            let intake = intake(login: login)
            guard case .activeWithForm(_, _, _, let form, let origin) = try await client.browserTakeover(
                intake: intake, action: ["action": .string("observe"), "native_fields": .bool(true), "native_field_hints": .bool(true), "native_field_controls": .bool(true)], configuration: fixture.configuration)
            else { return XCTFail("Expected native form discovery") }
            XCTAssertEqual(origin, login ? "https://example.com" : nil)
            XCTAssertEqual(form.fields.map(\.label), ["Email", "Password", "Notes", "Code", "Country", "Updates"])
            XCTAssertEqual(form.fields.map(\.type), ["email", "password", "text", "text", "select", "checkbox"])
            XCTAssertEqual(form.fields.map(\.multiline), [false, false, true, false, false, false])
            XCTAssertEqual(form.fields.map(\.autocomplete), ["username", "current-password", nil, "one-time-code", nil, nil])
            XCTAssertEqual(form.fields.map(\.inputmode), ["email", nil, nil, "numeric", nil, nil])
            XCTAssertEqual(form.reason, "Complete this profile")
            XCTAssertEqual(form.fields[4].options.map(\.index), [0, 2])
            XCTAssertEqual(form.fields[5].checked, true)
            XCTAssertThrowsError(try form.fillAction(values: [countryRef: "1"]))
            XCTAssertThrowsError(try form.fillAction(values: [updatesRef: "yes"]))
            XCTAssertThrowsError(try form.fillAction(values: ["unknown-reference": "synthetic"]))
            XCTAssertThrowsError(try form.fillAction(values: [passwordRef: String(repeating: "x", count: 4097)]))
            let fill = try form.fillAction(values: [usernameRef: "synthetic@example.com", passwordRef: "synthetic-password", notesRef: "Synthetic line one\nLine two", codeRef: "123456", countryRef: "2", updatesRef: "false"])
            let filled = try await client.browserTakeover(intake: intake, action: fill, configuration: fixture.configuration)
            switch filled {
            case .active, .loginActive: break
            default: XCTFail("Fill must leave the same browser active for handoff")
            }
            guard case .finished = try await client.browserTakeover(intake: intake,
                action: ["action": .string("finish")], configuration: fixture.configuration)
            else { return XCTFail("Expected handoff receipt, not an authentication assertion") }
        }
    }

    func testPrivateTransportRejectsValueBearingOrAmbiguousFormMetadata() async throws {
        var valueBearing = nativeForm
        var fields = try XCTUnwrap(valueBearing["fields"] as? [[String: Any]])
        fields[0]["value"] = "synthetic-private-value"
        valueBearing["fields"] = fields
        var duplicate = nativeForm
        duplicate["fields"] = [fields[1], fields[1]]
        var invalidDocument = nativeForm
        invalidDocument["document_id"] = "not-a-document"
        var invalidHint = nativeForm
        var hintFields = try XCTUnwrap(nativeForm["fields"] as? [[String: Any]])
        hintFields[0]["autocomplete"] = "synthetic-private-value"
        invalidHint["fields"] = hintFields
        var invalidMode = nativeForm
        hintFields[0]["autocomplete"] = "username"
        hintFields[0]["inputmode"] = 42
        invalidMode["fields"] = hintFields
        for form in [valueBearing, duplicate, invalidDocument, invalidHint, invalidMode] {
            let body = try response(form: form, login: true)
            let fixture = try HTTPFixture { _ in FixtureReply(body: body) }
            defer { fixture.close() }
            let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
            defer { client.close() }
            do {
                _ = try await client.browserTakeover(intake: intake(login: true),
                    action: ["action": .string("observe"), "native_fields": .bool(true)], configuration: fixture.configuration)
                XCTFail("Accepted unsafe form metadata")
            } catch {
                XCTAssertTrue(error is APIError)
                XCTAssertFalse(String(describing: error).contains("synthetic-private-value"))
            }
        }
    }
}
