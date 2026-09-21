import AVFoundation
import Foundation
import InboxCore
import XCTest
@testable import NanocodexVoice

/// Opt-in measurements of the Apple client's real managed connection. Receive-only
/// transport does not measure microphone startup, speech playback, or device latency.
final class VoiceLatencyTests: XCTestCase {
    @MainActor
    func testManagedStartupLatency() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["NANOCODEX_VOICE_LATENCY"] == "1", let key = environment["NC_API_KEY"] else {
            throw XCTSkip("Set NANOCODEX_VOICE_LATENCY=1 and NC_API_KEY for live startup measurements.")
        }
        let credential = try AccountCredential(
            origin: environment["NANOCODEX_MANAGED_URL"] ?? "https://nanocodex.gakonst.workers.dev", apiKey: key)
        let client = ManagedClient(credential: credential)
        defer { client.close() }
        let agentID = try await client.create(requestID: UUID().uuidString)
        print("Native latency validation agent: \(agentID)")
        let configuration = VoiceConfiguration(baseURL: try XCTUnwrap(URL(string: credential.origin)), apiKey: key,
                                               agentID: agentID, conversationTitle: "Voice latency validation", voice: "cove")
        let permission = AVCaptureDevice.authorizationStatus(for: .audio)
        do {
            for attempt in 1...3 {
                let voice = VoiceSession()
                do {
                    let began = ContinuousClock.now
                    voice.startReceivingForTesting(configuration: configuration)
                    let deadline = began.advanced(by: .seconds(50))
                    while voice.phase == .connecting, ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    guard voice.phase == .active else {
                        throw LatencyFailure(message: voice.errorMessage ?? "Media readiness timed out")
                    }
                    let duration = began.duration(to: .now).components
                    let readyMS = Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15
                    print("VOICE_LATENCY {\"attempt\":\(attempt),\"readyMs\":\(readyMS)}")
                    XCTAssertTrue(voice.hasNativePeerForTesting)
                    XCTAssertEqual(voice.audioBytesSent, 0)
                    XCTAssertEqual(AVCaptureDevice.authorizationStatus(for: .audio), permission)
                    try voice.sendRealtimeForTesting(.object(["type": .string("session.update"), "session": .object([:])]))
                    let ackDeadline = ContinuousClock.now.advanced(by: .seconds(10))
                    while !voice.receivedRealtimeTypesForTesting.contains("session.updated"), voice.isEngaged,
                          ContinuousClock.now < ackDeadline {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    XCTAssertTrue(voice.receivedRealtimeTypesForTesting.contains("session.updated"))
                    voice.stop()
                    XCTAssertFalse(voice.hasNativePeerForTesting)
                    await voice.finishStopping()
                } catch {
                    voice.stop()
                    await voice.finishStopping()
                    throw error
                }
            }
        } catch {
            try? await deleteAgent(agentID, client: client)
            throw error
        }
        try await deleteAgent(agentID, client: client)
    }

    private func deleteAgent(_ id: String, client: ManagedClient) async throws {
        for attempt in 0..<5 {
            do {
                _ = try await client.json(path: ManagedClient.agentPath(id), method: "DELETE")
                print("Native latency validation agent deleted: \(id)")
                return
            } catch APIError.http(404) { return }
            catch APIError.http(503) where attempt < 4 { try await Task.sleep(for: .seconds(2)) }
        }
    }
}

private struct LatencyFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
