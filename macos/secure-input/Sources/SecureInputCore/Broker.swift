import Foundation
import CryptoKit

public enum BoundaryError: Error { case invalid, denied, unavailable }
public struct Command: Codable, Equatable {
    public let executable: String
    public let arguments: [String]
    public let cwd: String
    public init(executable: String, arguments: [String], cwd: String) { self.executable = executable; self.arguments = arguments; self.cwd = cwd }
}
public struct Ticket: Codable {
    public let request_id: String
    public let command_digest: String
    public let public_key: String
    public let expires_at: Int64
    public let uid: UInt32
    public let command: Command
    public var helper_signature: String
    public var signingData: Data {
        Data(["nanocodex-secure-sudo-ticket-v1", request_id, command_digest, public_key, String(expires_at), String(uid)].joined(separator: "\n").utf8)
    }
}
public struct Envelope: Codable {
    public let request_id: String
    public let ephemeral_public_key: String
    public let ciphertext: String
    public var signature: String
    public init(request_id: String, ephemeral_public_key: String, ciphertext: String, signature: String) { self.request_id = request_id; self.ephemeral_public_key = ephemeral_public_key; self.ciphertext = ciphertext; self.signature = signature }
    public var signingData: Data { Data(["nanocodex-secure-sudo-v1", request_id, ephemeral_public_key, ciphertext].joined(separator: "\n").utf8) }
}
public struct Receipt: Codable {
    public let request_id: String
    public let status: String
    public let exit_code: Int32?
}
/// Serialized by the daemon. No ticket or decrypted material survives process restart.
/// Bound local socket work per peer UID. A slow or malformed user cannot hold the
/// single-threaded helper indefinitely or exhaust another user's allowance.
public struct AdmissionLimiter {
    private var windows: [UInt32: (until: TimeInterval, count: Int)] = [:]
    public init() {}
    public mutating func admit(uid: UInt32, now: TimeInterval) -> Bool {
        windows = windows.filter { $0.value.until > now }
        var window = windows[uid] ?? (until: now + 60, count: 0)
        guard window.count < 24 else { return false }
        window.count += 1
        windows[uid] = window
        return true
    }
}

public final class Broker {
    private struct Pending { let ticket: Ticket; let key: P256.KeyAgreement.PrivateKey }
    private var pending: [String: Pending] = [:]
    private let approvalKey: P256.Signing.PublicKey
    private let identity: P256.Signing.PrivateKey
    public init(approvalKey: P256.Signing.PublicKey, identity: P256.Signing.PrivateKey) { self.approvalKey = approvalKey; self.identity = identity }
    public func prepare(command: Command, uid: UInt32, now: Int64) throws -> Ticket {
        pending = pending.filter { $0.value.ticket.expires_at > now }
        guard uid > 0, pending.count < 32, pending.values.filter({ $0.ticket.uid == uid }).count < 4, command.executable.hasPrefix("/"), command.cwd.hasPrefix("/"), command.arguments.count <= 128,
              ([command.executable, command.cwd] + command.arguments).allSatisfy({ !$0.contains("\0") && $0.utf8.count <= 4096 }) else { throw BoundaryError.invalid }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        struct Binding: Encodable { let arguments: [String]; let cwd: String; let executable: String; let uid: UInt32 }
        let bytes = try encoder.encode(Binding(arguments: command.arguments, cwd: command.cwd, executable: command.executable, uid: uid))
        let digest = Data(SHA256.hash(data: bytes)).base64EncodedString()
        let key = P256.KeyAgreement.PrivateKey()
        var ticket = Ticket(request_id: UUID().uuidString.lowercased(), command_digest: digest, public_key: key.publicKey.x963Representation.base64EncodedString(), expires_at: now + 300000, uid: uid, command: command, helper_signature: "")
        ticket.helper_signature = try identity.signature(for: ticket.signingData).rawRepresentation.base64EncodedString()
        pending[ticket.request_id] = Pending(ticket: ticket, key: key)
        return ticket
    }
    public func cancel(_ requestID: String, uid: UInt32) throws {
        guard let item = pending[requestID], item.ticket.uid == uid else { throw BoundaryError.denied }
        pending.removeValue(forKey: requestID)
    }
    public func submit(_ envelope: Envelope, uid: UInt32, now: Int64, execute: (Command, UInt32, Data) throws -> Int32) throws -> Receipt {
        guard let item = pending[envelope.request_id], item.ticket.uid == uid, item.ticket.expires_at > now,
              envelope.ciphertext.utf8.count < 16384,
              let signatureBytes = Data(base64Encoded: envelope.signature),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signatureBytes),
              approvalKey.isValidSignature(signature, for: envelope.signingData) else { throw BoundaryError.denied }
        // Consume before decrypting or starting a process: ambiguity never permits retry.
        pending.removeValue(forKey: envelope.request_id)
        guard let peerBytes = Data(base64Encoded: envelope.ephemeral_public_key), let sealed = Data(base64Encoded: envelope.ciphertext) else { throw BoundaryError.invalid }
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: peerBytes)
        let shared = try item.key.sharedSecretFromKeyAgreement(with: peer)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data(envelope.request_id.utf8), outputByteCount: 32)
        var plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key)
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        struct Input: Decodable { let request_id: String; let command_digest: String; let value: String }
        let input = try JSONDecoder().decode(Input.self, from: plaintext)
        guard input.request_id == envelope.request_id, input.command_digest == item.ticket.command_digest,
              !input.value.isEmpty, input.value.utf8.count <= 4096,
              !input.value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw BoundaryError.invalid }
        var password = Data(input.value.utf8)
        defer { password.resetBytes(in: 0..<password.count) }
        do {
            let code = try execute(item.ticket.command, uid, password)
            return Receipt(request_id: envelope.request_id, status: "completed", exit_code: code)
        } catch {
            return Receipt(request_id: envelope.request_id, status: "outcome_unknown", exit_code: nil)
        }
    }
}
