import XCTest
import CryptoKit
@testable import SecureInputCore

final class BoundaryTests: XCTestCase {
    func testLocalAdmissionIsBoundedPerUIDAndResetsAfterWindow() {
        var limiter = AdmissionLimiter()
        for _ in 0..<24 { XCTAssertTrue(limiter.admit(uid: 501, now: 100)) }
        XCTAssertFalse(limiter.admit(uid: 501, now: 159.9))
        XCTAssertTrue(limiter.admit(uid: 502, now: 159.9), "An unrelated local user keeps their own allowance")
        XCTAssertTrue(limiter.admit(uid: 501, now: 160), "The sixty-second window resets")
    }

    func testApprovedEnvelopeIsBoundAndOneUse() throws {
        let authority = P256.Signing.PrivateKey()
        let broker = Broker(approvalKey: authority.publicKey, identity: .init())
        let ticket = try broker.prepare(command: .init(executable: "/usr/bin/true", arguments: [], cwd: "/"), uid: 501, now: 1000)
        let envelope = try seal(ticket, authority: authority)
        var calls = 0
        let receipt = try broker.submit(envelope, uid: 501, now: 1001) { command, uid, password in
            calls += 1
            XCTAssertEqual(command.executable, "/usr/bin/true")
            XCTAssertEqual(uid, 501)
            XCTAssertEqual(String(decoding: password, as: UTF8.self), "synthetic-only")
            return 0
        }
        XCTAssertEqual(receipt.status, "completed")
        XCTAssertEqual(calls, 1)
        XCTAssertThrowsError(try broker.submit(envelope, uid: 501, now: 1002) { _,_,_ in XCTFail(); return 0 })
    }
    func testTamperingExpiryCancellationAndWrongPeerNeverExecute() throws {
        let authority = P256.Signing.PrivateKey()
        for scenario in ["signature", "binding", "expired", "cancelled", "peer", "restart"] {
            let broker = Broker(approvalKey: authority.publicKey, identity: .init())
            let ticket = try broker.prepare(command: .init(executable: "/usr/bin/true", arguments: [], cwd: "/"), uid: 501, now: 1000)
            let envelope = try seal(ticket, authority: scenario == "signature" ? .init() : authority, digest: scenario == "binding" ? "wrong" : nil)
            if scenario == "cancelled" { try broker.cancel(ticket.request_id, uid: 501) }
            let target = scenario == "restart" ? Broker(approvalKey: authority.publicKey, identity: .init()) : broker
            XCTAssertThrowsError(try target.submit(envelope, uid: scenario == "peer" ? 502 : 501, now: scenario == "expired" ? 301001 : 1001) { _,_,_ in XCTFail(scenario); return 0 }, scenario)
        }
    }
    func testTicketIdentityRejectsSubstitution() throws {
        let identity = P256.Signing.PrivateKey()
        let broker = Broker(approvalKey: P256.Signing.PrivateKey().publicKey, identity: identity)
        let ticket = try broker.prepare(command: .init(executable: "/usr/bin/true", arguments: [], cwd: "/"), uid: 501, now: 1000)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: ticket.helper_signature)!)
        XCTAssertTrue(identity.publicKey.isValidSignature(signature, for: ticket.signingData))
        XCTAssertFalse(P256.Signing.PrivateKey().publicKey.isValidSignature(signature, for: ticket.signingData))
    }
    private func seal(_ ticket: Ticket, authority: P256.Signing.PrivateKey, digest: String? = nil) throws -> Envelope {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let recipient = try P256.KeyAgreement.PublicKey(x963Representation: Data(base64Encoded: ticket.public_key)!)
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data(ticket.request_id.utf8), outputByteCount: 32)
        let body = try JSONSerialization.data(withJSONObject: ["request_id": ticket.request_id, "command_digest": digest ?? ticket.command_digest, "value": "synthetic-only"])
        let box = try AES.GCM.seal(body, using: key)
        var envelope = Envelope(request_id: ticket.request_id, ephemeral_public_key: ephemeral.publicKey.x963Representation.base64EncodedString(), ciphertext: box.combined!.base64EncodedString(), signature: "")
        envelope.signature = try authority.signature(for: envelope.signingData).rawRepresentation.base64EncodedString()
        return envelope
    }
}
