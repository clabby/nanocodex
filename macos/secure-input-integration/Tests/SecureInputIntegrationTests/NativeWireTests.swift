import XCTest
import Foundation
import CryptoKit
import InboxCore
import SecureInputCore

final class NativeWireTests: XCTestCase {
    func testProductionClientAndHelperCompleteOneEncryptedApproval() async throws {
        let serverKey = P256.Signing.PrivateKey()
        let helperKey = P256.Signing.PrivateKey()
        let broker = Broker(approvalKey: serverKey.publicKey, identity: helperKey)
        let command = Command(executable: "/usr/bin/printf", arguments: ["%s", "quoted \"café\" / 😀"], cwd: "/")
        let uid: UInt32 = 501
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let ticket = try broker.prepare(command: command, uid: uid, now: now)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: XCTUnwrap(Data(base64Encoded: ticket.helper_signature)))
        XCTAssertTrue(helperKey.publicKey.isValidSignature(signature, for: ticket.signingData))
        let hint: JSON = .object([
            "type": .string("secure_input"), "status": .string("input_required"), "kind": .string("native_sudo"),
            "request_id": .string(ticket.request_id), "agent_id": .string("agent_integration"),
            "machine_id": .string("synthetic-mac"), "expires_at": .number(Double(ticket.expires_at))
        ])
        let intake = try XCTUnwrap(SecureInputRequest.parse(hint))
        let secret = "synthetic-password-é-🔐"
        let credential = try AccountCredential(origin: "https://native-wire.invalid", apiKey: "ncx_live_" + String(repeating: "x", count: 12) + "_" + String(repeating: "y", count: 43))
        let state = JourneyState()
        FixtureProtocol.install { request, body in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/agents/agent_integration/native-secure-input")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + credential.apiKey)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            let input = try JSONDecoder().decode(JSON.self, from: body)
            if input["action"].string == "describe" {
                state.describes += 1
                XCTAssertEqual(input["request_id"].string, ticket.request_id)
                return .object([
                    "request_id": .string(ticket.request_id), "machine_id": .string("synthetic-mac"),
                    "executable": .string(ticket.command.executable), "arguments": .array(ticket.command.arguments.map(JSON.string)),
                    "cwd": .string(ticket.command.cwd), "uid": .number(Double(ticket.uid)),
                    "expires_at": .number(Double(ticket.expires_at)), "command_digest": .string(ticket.command_digest),
                    "public_key": .string(ticket.public_key)
                ])
            }
            state.submissions += 1
            let fields = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(Set(fields.keys), Set(["request_id", "ephemeral_public_key", "ciphertext"]))
            XCTAssertFalse(String(decoding: body, as: UTF8.self).contains(secret))
            // The synthetic transport signs the real client envelope; it never decrypts it.
            var envelope = Envelope(request_id: input["request_id"].string,
                                    ephemeral_public_key: input["ephemeral_public_key"].string,
                                    ciphertext: input["ciphertext"].string, signature: "")
            envelope.signature = try serverKey.signature(for: envelope.signingData).rawRepresentation.base64EncodedString()
            let receipt = try broker.submit(envelope, uid: uid, now: now + 1) { receivedCommand, receivedUID, password in
                state.executions += 1
                XCTAssertEqual(receivedCommand, command)
                XCTAssertEqual(receivedUID, uid)
                XCTAssertEqual(password, Data(secret.utf8))
                return 0
            }
            XCTAssertEqual(receipt.request_id, ticket.request_id)
            XCTAssertEqual(receipt.status, "completed")
            XCTAssertEqual(receipt.exit_code, 0)
            XCTAssertThrowsError(try broker.submit(envelope, uid: uid, now: now + 2) { _, _, _ in
                state.executions += 1
                XCTFail("Consumed approval executed twice")
                return 0
            })
            return .object(["type": .string("secure_input_receipt"), "request_id": .string(receipt.request_id), "status": .string(receipt.status)])
        }
        defer { FixtureProtocol.install(nil) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureProtocol.self]
        let client = ManagedClient(credential: credential, configuration: configuration)
        defer { client.close() }
        let description = try await client.describeNativeSecureInput(intake, configuration: configuration)
        XCTAssertEqual(description.executable, command.executable)
        XCTAssertEqual(description.arguments, command.arguments)
        XCTAssertEqual(description.cwd, command.cwd)
        XCTAssertEqual(description.uid, uid)
        let receipt = try await client.submitNativeSecureInput(intake, description: description, value: secret, configuration: configuration)
        XCTAssertEqual(receipt.status, "completed")
        // All fixture callbacks finish before the HTTP response reaches the client.
        XCTAssertEqual(state.describes, 1)
        XCTAssertEqual(state.submissions, 1)
        XCTAssertEqual(state.executions, 1)
    }
}

private final class JourneyState {
    var describes = 0
    var submissions = 0
    var executions = 0
}

/// Only HTTP delivery is replaced. No encryption, decryption or digest implementation lives here.
private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handler: ((URLRequest, Data) throws -> JSON)?
    static func install(_ handler: ((URLRequest, Data) throws -> JSON)?) {
        lock.lock(); defer { lock.unlock() }
        self.handler = handler
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard request.url?.host == "native-wire.invalid" else { throw URLError(.unsupportedURL) }
            var body = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count >= 0 else { throw URLError(.cannotDecodeRawData) }
                    if count == 0 { break }
                    body.append(contentsOf: buffer.prefix(count))
                }
            }
            Self.lock.lock()
            let reply: JSON
            do {
                guard let handler = Self.handler else { throw URLError(.resourceUnavailable) }
                reply = try handler(request, body)
                Self.lock.unlock()
            } catch { Self.lock.unlock(); throw error }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "Cache-Control": "no-store"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONEncoder().encode(reply))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
