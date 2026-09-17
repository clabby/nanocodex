import XCTest
@testable import InboxCore

final class ProjectTaskTests: XCTestCase {
    func testRosterPreservesServerProjectLineageAndTaskIdentity() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents")
            return FixtureReply(body: #"{"data":["master","child"],"summaries":{"master":{"title":"Orbit"},"child":{"title":"Long prompt","project_title":"Fix sign-in","project_root_id":"master","parent_agent_id":"master","origin_turn_id":"request-1","project_turn_id":"project:fix"}}}"#)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let cards = try await client.list()
        XCTAssertNil(cards[0].projectRootID)
        XCTAssertEqual(cards[1].title, "Fix sign-in")
        XCTAssertEqual(cards[1].projectRootID, "master")
        XCTAssertEqual(cards[1].parentAgentID, "master")
        XCTAssertEqual(cards[1].originTurnID, "request-1")
        XCTAssertEqual(cards[1].projectTurnID, "project:fix")
    }

    func testTaskIdentityAndTerminalOutcomeDoNotDependOnPartialHistory() throws {
        var user = TranscriptRow(id: "input", role: "You", text: "Fix sign in")
        user.turnID = "one"
        let completed = try AgentEvent(.object(["type": .string("turn_completed"), "turn_id": .string("one")]), cursor: "10")
        let tasks = ProjectTask.project(agentID: "main", rows: [user], events: [completed], activeTurns: [], pending: [])
        XCTAssertEqual(tasks.first?.id, "main:one")
        XCTAssertEqual(tasks.first?.title, "Fix sign in")
        XCTAssertEqual(tasks.first?.status, "Completed")
        XCTAssertFalse(tasks.first!.isLive)
    }
    func testActiveAndQueuedTasksWithoutLoadedInputsStayVisible() {
        let tasks = ProjectTask.project(agentID: "main", rows: [], events: [], activeTurns: ["one", "two"], pending: [])
        XCTAssertEqual(tasks.count, 2)
        XCTAssertEqual(tasks.first { $0.turnID == "one" }?.status, "Working")
        XCTAssertEqual(tasks.first { $0.turnID == "two" }?.status, "Queued")
        XCTAssertTrue(tasks.allSatisfy(\.isLive))
    }
    func testPartialHistoryDoesNotInventCompletion() {
        var row = TranscriptRow(id: "partial", role: "Agent", text: "Checking")
        row.turnID = "one"; row.phase = "commentary"
        let tasks = ProjectTask.project(agentID: "main", rows: [row], events: [], activeTurns: [], pending: [])
        XCTAssertEqual(tasks.first?.status, "History")
    }
    func testProjectCreationIdentityMigrationAndRoundTrip() throws {
        var project = InboxProject(id: "project", name: "Orbit", primaryAgentID: "draft", agentIDs: ["draft", "server", "other"])
        project.replaceAgent("draft", with: "server")
        XCTAssertEqual(project.primaryAgentID, "server")
        XCTAssertEqual(project.agentIDs, ["server", "other"])
        XCTAssertEqual(try JSONDecoder().decode(InboxProject.self, from: JSONEncoder().encode(project)), project)
    }
}
