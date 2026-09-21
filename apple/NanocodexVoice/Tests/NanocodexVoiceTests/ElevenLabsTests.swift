import XCTest
import InboxCore
@testable import NanocodexVoice

final class ElevenLabsTests: XCTestCase {
    func testLegacySettingsAndProviderContract() throws {
        let old = try JSONDecoder().decode(VoiceSettings.self, from: Data("{}".utf8))
        XCTAssertNil(old.outputProvider)
        _ = try ManagedVoiceProtocol(settings: old)
        let settings = VoiceSettings(outputProvider: .elevenlabs, elevenLabsVoiceId: "synthetic_voice")
        _ = try ManagedVoiceProtocol(settings: settings)
        let encoded = try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(encoded["outputProvider"].string, "elevenlabs")
        XCTAssertThrowsError(try ManagedVoiceProtocol(settings: VoiceSettings(outputProvider: .elevenlabs)))
    }
    func testCaptionSegmentsAndInterruptedFinalStaySuppressed() {
        var captions = VoiceSpeechCaptions()
        XCTAssertNil(captions.consume(.init(speaker: "assistant", text: "Hello", isFinal: false, id: 1)))
        XCTAssertEqual(captions.consume(.init(speaker: "assistant", text: "Hello. More", isFinal: false, id: 1)), "Hello.")
        XCTAssertEqual(captions.consume(.init(speaker: "assistant", text: "Hello. More words.", id: 1)), "More words.")
        XCTAssertNil(captions.consume(.init(speaker: "assistant", text: "Hello. More words.", id: 1)))
        captions.interrupt()
        XCTAssertNil(captions.consume(.init(speaker: "assistant", text: "Hello. More words. Late final", id: 1)))
        XCTAssertEqual(captions.consume(.init(speaker: "assistant", text: "New response", id: 2)), "New response")
        XCTAssertNil(captions.consume(.init(speaker: "assistant", text: "Old response", id: 1)))
    }
    func testAccountAuthenticatedSpeechContract() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/api/voice/elevenlabs/speech")
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.headers["authorization"], "Bearer \(fixtureKey)")
            XCTAssertNil(request.headers["xi-api-key"])
            XCTAssertEqual(request.json["voice_id"] as? String, "synthetic_voice")
            XCTAssertEqual(request.json["output_format"] as? String, "mp3_44100_128")
            XCTAssertEqual(request.json["text"] as? String, "Test speech")
            return FixtureReply(headers: ["Content-Type": "audio/mpeg"], body: "audio")
        }
        let client = try ElevenLabs(configuration: .init(baseURL: URL(string: fixture.origin)!, apiKey: fixtureKey, agentID: "019d2f5d-7491-8000-8000-000000000001"), urlConfiguration: fixture.configuration)
        let data = try await client.speech(text: "Test speech", voiceID: "synthetic_voice")
        XCTAssertEqual(data, Data("audio".utf8))
    }
    func testCloneRequiresConsentAndReturnsVerificationWithoutRetry() async throws {
        var requests = 0
        let fixture = try HTTPFixture { request in
            requests += 1
            XCTAssertEqual(request.path, "/api/voice/elevenlabs/voices")
            XCTAssertTrue(request.headers["content-type"]?.hasPrefix("multipart/form-data; boundary=") == true)
            let body = String(decoding: request.body, as: UTF8.self)
            XCTAssertTrue(body.contains("name=\"consent\"\r\n\r\ntrue"))
            XCTAssertTrue(body.contains("name=\"files\"; filename=\"sample-0.wav\""))
            XCTAssertFalse(body.contains("private-sample"))
            return FixtureReply(status: 201, body: "{\"voice_id\":\"synthetic_clone\",\"requires_verification\":true}")
        }
        defer { fixture.close() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("private-sample-" + UUID().uuidString + ".wav")
        try Data("synthetic wave fixture".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let client = try ElevenLabs(configuration: .init(baseURL: URL(string: fixture.origin)!, apiKey: fixtureKey, agentID: "019d2f5d-7491-8000-8000-000000000001"), urlConfiguration: fixture.configuration)
        do { _ = try await client.clone(name: "Synthetic", files: [file], consent: false); XCTFail("Consent is required") } catch {}
        XCTAssertEqual(requests, 0)
        let result = try await client.clone(name: "Synthetic", files: [file], consent: true)
        XCTAssertTrue(result["requires_verification"].bool)
        XCTAssertEqual(requests, 1)
    }
    @MainActor func testCancelRevokesPendingAudioAndQueuedRequests() async throws {
        let began = expectation(description: "first synthesis began")
        let player = VoiceSpeechPlayer()
        player.enqueue(audio: {
            began.fulfill()
            try await Task.sleep(for: .seconds(5))
            return Data()
        }, onError: { _ in XCTFail("Cancelled audio must not produce an error") })
        player.enqueue(audio: { XCTFail("Queued synthesis must be revoked"); return Data() }, onError: { _ in XCTFail("Cancelled queue must not produce an error") })
        await fulfillment(of: [began], timeout: 1)
        player.cancel()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(player.level, 0)
    }

}
