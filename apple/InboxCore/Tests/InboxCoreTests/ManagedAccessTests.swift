import Foundation
import XCTest
import InboxCore

final class ManagedAccessTests: XCTestCase {
    func testReusesAuthorityAcrossClientsAndRetriesRejectedSnapshotOnce() async throws {
        var calls = 0
        let fixture = try HTTPFixture { request in
            calls += 1
            XCTAssertEqual(request.headers["authorization"], "Bearer " + fixtureKey)
            if calls == 1 {
                XCTAssertNil(request.headers["x-nanocodex-access"])
                return FixtureReply(headers: ["Content-Type": "application/json", "x-nanocodex-access": "ncx_access_v1.fixture.signature", "x-nanocodex-access-ttl-ms": "120000"])
            }
            if calls == 2 {
                XCTAssertEqual(request.headers["x-nanocodex-access"], "ncx_access_v1.fixture.signature")
                return FixtureReply(status: 401, headers: ["x-nanocodex-access-rejected": "1"])
            }
            XCTAssertNil(request.headers["x-nanocodex-access"])
            XCTAssertEqual(request.json["text"] as? String, "hello")
            XCTAssertEqual(request.headers["idempotency-key"], "same-operation")
            return FixtureReply()
        }
        defer { fixture.close() }
        let credential = try AccountCredential(origin: fixture.origin, apiKey: fixtureKey)
        let first = ManagedClient(credential: credential, configuration: fixture.configuration)
        let second = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { first.close(); second.close() }
        _ = try await first.json(path: "/v1/agents/one")
        _ = try await second.json(path: "/v1/agents/one/turns", method: "POST", body: .object(["text": .string("hello")]), idempotencyKey: "same-operation")
        XCTAssertEqual(calls, 3)
    }

    func testDoesNotReuseAcrossAccountsOrForAccountAdministration() async throws {
        var calls = 0
        let fixture = try HTTPFixture { request in
            calls += 1
            XCTAssertNil(request.headers["x-nanocodex-access"])
            return calls == 1 ? FixtureReply(headers: ["Content-Type": "application/json", "x-nanocodex-access": "ncx_access_v1.fixture.signature", "x-nanocodex-access-ttl-ms": "120000"]) : FixtureReply()
        }
        defer { fixture.close() }
        let first = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        let second = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey.replacingOccurrences(of: "x", with: "y", range: fixtureKey.index(fixtureKey.startIndex, offsetBy: 22)..<fixtureKey.endIndex)), configuration: fixture.configuration)
        defer { first.close(); second.close() }
        _ = try await first.json(path: "/v1/agents/one")
        _ = try await second.json(path: "/v1/agents/one")
        _ = try await first.json(path: "/v1/api-keys")
        XCTAssertEqual(calls, 3)
    }
}
