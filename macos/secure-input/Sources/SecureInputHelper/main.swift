import Foundation
import CryptoKit
import Security
import Darwin
import CSecureSudo
import SecureInputCore

let directory = "/Library/Application Support/NanocodexSecureInput"
let configPath = directory + "/configuration.json"
let socketPath = "/var/run/nanocodex-secure-input.sock"
struct Configuration: Codable { let approval_public_key: String; let identity_private_key: String }

func protectedPath(_ path: String, directory: Bool = false, mode: mode_t? = nil) throws {
    var info = stat()
    guard lstat(path, &info) == 0, info.st_uid == 0,
          (info.st_mode & S_IFMT) == (directory ? S_IFDIR : S_IFREG),
          info.st_mode & 0o022 == 0,
          mode == nil || info.st_mode & 0o7777 == mode! else { throw BoundaryError.unavailable }
}
func checkInstallation() throws {
    try protectedPath("/Library", directory: true)
    try protectedPath("/Library/PrivilegedHelperTools", directory: true)
    let executable = "/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.secure-input"
    try protectedPath(executable, mode: 0o755)
    try protectedPath("/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.secure-askpass", mode: 0o4755)
    // Reject unsigned/ad-hoc/debug distribution. The installer also verifies both binaries.
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { throw BoundaryError.unavailable }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { throw BoundaryError.unavailable }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let info = information as? [String: Any], let team = info[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty,
          let flags = info[kSecCodeInfoFlags as String] as? UInt32, flags & 0x10000 != 0,
          (info[kSecCodeInfoEntitlementsDict as String] as? [String: Any])?["com.apple.security.get-task-allow"] as? Bool != true else { throw BoundaryError.unavailable }
    let developerID = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
    var selfRequirement: SecRequirement?
    let selfRule = "\(developerID) and identifier \"xyz.paradigm.nanocodex.secure-input\" and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(selfRule as CFString, [], &selfRequirement) == errSecSuccess,
          SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), selfRequirement) == errSecSuccess else { throw BoundaryError.unavailable }
    var askpass: SecStaticCode?
    let askpassURL = URL(fileURLWithPath: "/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.secure-askpass")
    guard SecStaticCodeCreateWithPath(askpassURL as CFURL, [], &askpass) == errSecSuccess, let askpass else { throw BoundaryError.unavailable }
    var requirement: SecRequirement?
    let rule = "\(developerID) and identifier \"xyz.paradigm.nanocodex.secure-askpass\" and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
          SecStaticCodeCheckValidity(askpass, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw BoundaryError.unavailable }
    var askpassInformation: CFDictionary?
    guard SecCodeCopySigningInformation(askpass, SecCSFlags(rawValue: kSecCSSigningInformation), &askpassInformation) == errSecSuccess,
          let askpassInfo = askpassInformation as? [String: Any],
          let askpassFlags = askpassInfo[kSecCodeInfoFlags as String] as? UInt32, askpassFlags & 0x10000 != 0,
          (askpassInfo[kSecCodeInfoEntitlementsDict as String] as? [String: Any])?["com.apple.security.get-task-allow"] as? Bool != true else { throw BoundaryError.unavailable }
}
func configuration() throws -> Configuration {
    try protectedPath("/Library/Application Support", directory: true)
    try protectedPath(directory, directory: true, mode: 0o700)
    try protectedPath(configPath, mode: 0o600)
    let bytes = try Data(contentsOf: URL(fileURLWithPath: configPath))
    guard bytes.count < 4096 else { throw BoundaryError.unavailable }
    return try JSONDecoder().decode(Configuration.self, from: bytes)
}
func enroll(_ publicKey: String) throws {
    guard let key = Data(base64Encoded: publicKey) else { throw BoundaryError.invalid }
    _ = try P256.Signing.PublicKey(x963Representation: key)
    try protectedPath("/Library/Application Support", directory: true)
    guard mkdir(directory, 0o700) == 0 || errno == EEXIST else { throw BoundaryError.unavailable }
    try protectedPath(directory, directory: true, mode: 0o700)
    // No automatic key replacement. Re-enrollment is an explicit local administrative operation.
    let fd = open(configPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw BoundaryError.unavailable }
    defer { close(fd) }
    let identity = P256.Signing.PrivateKey()
    let config = Configuration(approval_public_key: publicKey, identity_private_key: identity.rawRepresentation.base64EncodedString())
    var bytes = try JSONEncoder().encode(config)
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    let count = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    guard count == bytes.count, fsync(fd) == 0 else { throw BoundaryError.unavailable }
    print(identity.publicKey.x963Representation.base64EncodedString())
}
func readRequest(_ fd: Int32) throws -> Data {
    var bytes = Data(); var byte: UInt8 = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    while bytes.count < 32768 {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { throw BoundaryError.invalid }
        var event = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&event, 1, Int32(max(1, remaining * 1000))) > 0,
              event.revents & Int16(POLLIN) != 0,
              read(fd, &byte, 1) == 1 else { throw BoundaryError.invalid }
        if byte == 10 { return bytes }
        bytes.append(byte)
    }
    throw BoundaryError.invalid
}
func run(_ broker: Broker, bytes: Data, uid: UInt32) throws -> Data {
    struct Request: Decodable {
        let operation: String
        let executable: String?
        let arguments: [String]?
        let cwd: String?
        let request_id: String?
    }
    let request = try JSONDecoder().decode(Request.self, from: bytes)
    let encoder = JSONEncoder()
    switch request.operation {
    case "prepare":
        guard let executable = request.executable, let arguments = request.arguments, let cwd = request.cwd else { throw BoundaryError.invalid }
        return try encoder.encode(broker.prepare(command: Command(executable: executable, arguments: arguments, cwd: cwd), uid: uid, now: Int64(Date().timeIntervalSince1970 * 1000)))
    case "cancel":
        guard let id = request.request_id else { throw BoundaryError.invalid }
        try broker.cancel(id, uid: uid)
        return try JSONSerialization.data(withJSONObject: ["request_id": id, "status": "cancelled"])
    case "submit":
        let envelope = try JSONDecoder().decode(Envelope.self, from: bytes)
        return try encoder.encode(broker.submit(envelope, uid: uid, now: Int64(Date().timeIntervalSince1970 * 1000)) { command, uid, password in
            let strings = command.arguments.map { strdup($0) }
            defer { strings.forEach { free($0) } }
            guard strings.allSatisfy({ $0 != nil }) else { throw BoundaryError.unavailable }
            let args: [UnsafePointer<CChar>?] = strings.map { $0.map { UnsafePointer($0) } }
            let result = args.withUnsafeBufferPointer { buffer in
                password.withUnsafeBytes { secret in
                    nc_secure_sudo(uid, command.cwd, command.executable, buffer.baseAddress, args.count, secret.bindMemory(to: UInt8.self).baseAddress, password.count)
                }
            }
            guard result >= 0 else { throw BoundaryError.unavailable }
            return result
        })
    default: throw BoundaryError.invalid
    }
}
// No shell-controlled environment chooses key, executable, socket or configuration paths.
signal(SIGPIPE, SIG_IGN)
// Fail closed before configuration keys or decrypted values enter this process.
guard nc_secure_disable_core_dumps() == 0, getuid() == 0, geteuid() == 0 else { exit(78) }
do {
    try checkInstallation()
    if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--enroll" {
        try enroll(CommandLine.arguments[2]); exit(0)
    }
    let config = try configuration()
    guard let approvalBytes = Data(base64Encoded: config.approval_public_key), let identityBytes = Data(base64Encoded: config.identity_private_key) else { throw BoundaryError.unavailable }
    let identity = try P256.Signing.PrivateKey(rawRepresentation: identityBytes)
    if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--identity" { print(identity.publicKey.x963Representation.base64EncodedString()); exit(0) }
    guard CommandLine.arguments.count == 1 else { throw BoundaryError.invalid }
    let broker = Broker(approvalKey: try P256.Signing.PublicKey(x963Representation: approvalBytes), identity: identity)
    let privateDirectory = "/var/run/nanocodex-secure-input"
    guard mkdir(privateDirectory, 0o700) == 0 || errno == EEXIST else { throw BoundaryError.unavailable }
    try protectedPath(privateDirectory, directory: true, mode: 0o700)
    let listener = nc_secure_listen(socketPath, 0o666)
    guard listener >= 0 else { throw BoundaryError.unavailable }
    defer { close(listener); unlink(socketPath) }
    var admission = AdmissionLimiter()
    while true {
        var uid: UInt32 = 0
        let peer = nc_secure_accept(listener, &uid)
        if peer < 0 { continue }
        guard admission.admit(uid: uid, now: ProcessInfo.processInfo.systemUptime) else { close(peer); continue }
        let response: Data
        do { response = try run(broker, bytes: readRequest(peer), uid: uid) }
        catch { response = Data("{\"status\":\"rejected\"}".utf8) }
        var frame = response; frame.append(10)
        frame.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let n = write(peer, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if n <= 0 { break }; offset += n
            }
        }
        close(peer)
    }
} catch { exit(78) }
