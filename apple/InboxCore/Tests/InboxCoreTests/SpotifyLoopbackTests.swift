import XCTest
@testable import InboxCore

final class SpotifyLoopbackTests: XCTestCase {
    private let state = String(repeating: "s", count: 43)
    private func request(_ query: String, host: String = "127.0.0.1:8989") -> String {
        "GET /login?\(query) HTTP/1.1\r\nHost: \(host)\r\n\r\n"
    }

    func testCallbackValidation() {
        let valid = request("code=one-time-code&state=\(state)")
        XCTAssertEqual(SpotifyLoopbackCallback.parse(valid, expectedState: state)?.body,
                       .object(["code": .string("one-time-code"), "state": .string(state)]))
        for invalid in [
            request("code=code&state=wrong"), request("code=code&state=\(state)&state=\(state)"),
            request("code=code&error=denied&state=\(state)"), request("code=&state=\(state)"),
            request("code=code&state=\(state)", host: "attacker.test"),
            request("access_token=secret&state=\(state)"), valid.replacingOccurrences(of: "GET", with: "POST"),
            valid.replacingOccurrences(of: "/login?", with: "//attacker.test/login?"),
            valid.replacingOccurrences(of: "\r\n\r\n", with: "\r\nHost: evil\r\n\r\n"),
            valid + "extra body", request("code=%0Asecret&state=\(state)")
        ] { XCTAssertNil(SpotifyLoopbackCallback.parse(invalid, expectedState: state)) }
        XCTAssertEqual(SpotifyLoopbackCallback.parse(request("error=access_denied&state=\(state)"), expectedState: state)?.error, "access_denied")
    }

    @MainActor
    func testLiveLoopbackRejectsWrongStateThenDeliversCodeOnce() async throws {
        let receiver = SpotifyLoopbackReceiver()
        defer { receiver.stop() }
        try await receiver.start()
        receiver.expect(state: state)
        let received = expectation(description: "one valid callback")
        received.assertForOverFulfill = true
        receiver.onCallback = { callback in
            XCTAssertEqual(callback.code, "test-code")
            received.fulfill()
        }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (_, wrong) = try await session.data(from: URL(string: "http://127.0.0.1:8989/login?code=wrong&state=wrong")!)
        XCTAssertEqual((wrong as? HTTPURLResponse)?.statusCode, 400)
        let (data, valid) = try await session.data(from: URL(string: "http://127.0.0.1:8989/login?code=test-code&state=\(state)")!)
        XCTAssertEqual((valid as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("test-code"))
        await fulfillment(of: [received], timeout: 3)
        do {
            _ = try await session.data(from: URL(string: "http://127.0.0.1:8989/login?code=test-code&state=\(state)")!)
            XCTFail("Listener should close after one callback")
        } catch { }
    }

    @MainActor
    func testOccupiedPortFailsAndCancellationReleasesPort() async throws {
        let first = SpotifyLoopbackReceiver(), second = SpotifyLoopbackReceiver()
        defer { first.stop(); second.stop() }
        try await first.start()
        do { try await second.start(); XCTFail("Must not share a callback port") } catch { }
        first.stop()
        try await second.start()
    }
}
