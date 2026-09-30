import Foundation
import XCTest
import InboxCore

final class SessionDoneTransportTests: XCTestCase {
    func testExplicitDoneAndReopenUseOneScopedWriteEach() async throws {
        var writes = 0
        let fixture = try HTTPFixture { request in
            writes += 1
            XCTAssertEqual(request.path, "/v1/agents/synthetic/done")
            XCTAssertEqual(request.method, "PUT")
            XCTAssertEqual(request.headers["authorization"], "Bearer " + fixtureKey)
            let done = request.json["done"] as? Bool
            XCTAssertEqual(done, writes == 1)
            XCTAssertEqual(request.json.count, 1)
            return FixtureReply(body: done == true ? "{\"done\":true,\"done_at\":123,\"presentation_revision\":6}" : "{\"done\":false,\"done_at\":null}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let done = try await client.setDone("synthetic", done: true)
        XCTAssertTrue(done.done); XCTAssertEqual(done.doneAt, 123); XCTAssertEqual(done.presentationRevision, 6)
        let reopened = try await client.setDone("synthetic", done: false)
        XCTAssertFalse(reopened.done); XCTAssertNil(reopened.doneAt)
        XCTAssertEqual(writes, 2)
    }

    func testFailureAndMalformedReceiptAreNotRetriedOrReportedAsSuccess() async throws {
        for reply in [FixtureReply(status: 503, body: "{}"), FixtureReply(body: "{}"),
                      FixtureReply(body: "{\"done\":false,\"done_at\":null}"),
                      FixtureReply(body: "{\"done\":true,\"done_at\":null}")] {
            var writes = 0
            let fixture = try HTTPFixture { _ in writes += 1; return reply }
            defer { fixture.close() }
            let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
            defer { client.close() }
            do { _ = try await client.setDone("synthetic", done: true); XCTFail("Unconfirmed receipt must fail") }
            catch { }
            XCTAssertEqual(writes, 1)
        }
    }

    func testRosterReadsManualDoneSeparatelyFromExecutionStatus() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "GET")
            return FixtureReply(body: "{\"data\":[\"synthetic\"],\"summaries\":{\"synthetic\":{\"title\":\"Working\",\"turn_count\":1,\"presentation\":{\"done\":true,\"doneAt\":123,\"status\":\"running\",\"updatedAt\":456}}}}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let cards = try await client.list()
        let card = try XCTUnwrap(cards.first)
        XCTAssertTrue(card.done); XCTAssertEqual(card.doneAt, 123)
        XCTAssertTrue(card.isRunningInSidebar)
    }
}
