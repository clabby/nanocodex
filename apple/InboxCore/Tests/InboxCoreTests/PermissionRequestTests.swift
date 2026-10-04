import Foundation
import XCTest
@testable import InboxCore

/// Native transport coverage: UI rendering and browser owner authentication need
/// an iOS simulator and the managed worker journey, respectively.
final class PermissionRequestTests: XCTestCase {
    private let requestID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private func hint(keyID: String = "abcdefgh1234") -> JSON {
        .object(["type": .string("permission_request"), "status": .string("pending"),
                 "request_id": .string(requestID), "key_id": .string(keyID),
                 "capabilities": .array([.string("untrusted:scope")]),
                 "reason": .string("Untrusted reason"), "approval_url": .string("https://untrusted.invalid/")])
    }
    private func serverReply(status: String = "pending", id: String? = nil) -> String {
        JSON.object(["type": .string("permission_request"), "status": .string(status),
                     "request_id": .string(id ?? requestID), "key_id": .string("abcdefgh1234"),
                     "key_label": .string("Test phone"), "reason": .string("Save the requested record"),
                     "expires_at": .number(Date().addingTimeInterval(900).timeIntervalSince1970 * 1000),
                     "capabilities": .array([.string("data:write")]), "can_decide": .bool(false),
                     "capability_descriptions": .object(["data:write": .string("Write account data")])]).pretty
    }

    func testNativeReviewUsesAuthoritativeTransportThenRefreshesBrowserDecision() async throws {
        var tool = ToolPresentation(name: "request_permissions", arguments: .null)
        tool.finish(hint())
        let request = try XCTUnwrap(tool.permissionRequest)
        let pending = serverReply(), approved = serverReply(status: "approved")
        var calls = 0
        let fixture = try HTTPFixture { outgoing in
            calls += 1
            XCTAssertEqual(outgoing.method, "GET")
            XCTAssertEqual(outgoing.path, "/v1/permission-requests/abcdefgh1234/" + self.requestID)
            XCTAssertEqual(outgoing.headers["authorization"], "Bearer " + fixtureKey)
            XCTAssertEqual(outgoing.headers["cache-control"], "no-store")
            XCTAssertNil(outgoing.headers["cookie"])
            XCTAssertTrue(outgoing.body.isEmpty)
            return FixtureReply(body: calls == 1 ? pending : approved)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let review = try await client.permissionRequestReview(request, configuration: fixture.configuration)
        XCTAssertEqual(review.keyLabel, "Test phone")
        XCTAssertEqual(review.reason, "Save the requested record")
        XCTAssertEqual(review.capabilities.map(\.id), ["data:write"])
        XCTAssertEqual(review.capabilities.first?.description, "Write account data")
        XCTAssertTrue(review.isPending)
        let url = try client.permissionRequestApprovalURL(request)
        XCTAssertEqual(url.host, URL(string: fixture.origin)?.host)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.first(where: { $0.name == "permission_request" })?.value, requestID)
        XCTAssertEqual(query?.first(where: { $0.name == "key_id" })?.value, "abcdefgh1234")
        XCTAssertFalse(url.absoluteString.contains(fixtureKey))
        let result = try await client.permissionRequestReview(request, configuration: fixture.configuration)
        XCTAssertEqual(result.status, "approved")
        XCTAssertFalse(result.isPending)
        XCTAssertEqual(result.receipt["request_id"].string, requestID)
        XCTAssertEqual(result.receipt["status"].string, "approved")
        XCTAssertFalse(result.receipt.pretty.contains(fixtureKey))
        XCTAssertEqual(calls, 2)
    }

    func testOtherAccountAndMismatchedServerRequestCannotBeReviewed() async throws {
        let response = serverReply(id: "11111111-2222-4333-8444-555555555555")
        var calls = 0
        let fixture = try HTTPFixture { _ in calls += 1; return FixtureReply(body: response) }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let foreign = try XCTUnwrap(PermissionRequest.parse(hint(keyID: "otherkey1234")))
        XCTAssertThrowsError(try client.permissionRequestApprovalURL(foreign))
        do {
            _ = try await client.permissionRequestReview(foreign, configuration: fixture.configuration)
            XCTFail("A foreign key must not receive current credentials")
        } catch { XCTAssertEqual(calls, 0) }
        let own = try XCTUnwrap(PermissionRequest.parse(hint()))
        do {
            _ = try await client.permissionRequestReview(own, configuration: fixture.configuration)
            XCTFail("A response for another request must not be shown")
        } catch { XCTAssertEqual(calls, 1) }
    }

    func testFailedReviewDoesNotReplayOrExposeErrorBodyAndOrdinaryToolsCannotOpenCard() async throws {
        var calls = 0
        let fixture = try HTTPFixture { _ in calls += 1; return FixtureReply(status: 403, body: "private-server-error") }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let request = try XCTUnwrap(PermissionRequest.parse(hint()))
        do {
            _ = try await client.permissionRequestReview(request, configuration: fixture.configuration)
            XCTFail("Expected forbidden")
        } catch { XCTAssertFalse(String(describing: error).contains("private-server-error")) }
        XCTAssertEqual(calls, 1)
        var ordinary = ToolPresentation(name: "browser_execute", arguments: .null)
        ordinary.finish(hint())
        XCTAssertNil(ordinary.permissionRequest)
        var failed = ToolPresentation(name: "request_permissions", arguments: .null)
        failed.finish(hint(), failed: true)
        XCTAssertNil(failed.permissionRequest)
    }
}
