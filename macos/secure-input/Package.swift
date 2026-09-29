// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "NanocodexSecureInput", platforms: [.macOS(.v14)], products: [
    .library(name: "SecureInputCore", targets: ["SecureInputCore"]),
    .executable(name: "nanocodex-secure-input-helper", targets: ["SecureInputHelper"]),
    .executable(name: "nanocodex-secure-askpass", targets: ["SecureAskpass"])
], targets: [
    .target(name: "CSecureSudo", publicHeadersPath: "include"),
    .executableTarget(name: "SecureAskpass"),
    .target(name: "SecureInputCore", dependencies: ["CSecureSudo"]),
    .executableTarget(name: "SecureInputHelper", dependencies: ["SecureInputCore", "CSecureSudo"]),
    .testTarget(name: "SecureInputCoreTests", dependencies: ["SecureInputCore", "CSecureSudo"])
])
