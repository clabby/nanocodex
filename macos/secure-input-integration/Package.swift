// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SecureInputIntegration",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../secure-input"),
        .package(path: "../../apple/InboxCore")
    ],
    targets: [
        .testTarget(name: "SecureInputIntegrationTests", dependencies: [
            .product(name: "SecureInputCore", package: "secure-input"),
            .product(name: "InboxCore", package: "InboxCore")
        ])
    ]
)
