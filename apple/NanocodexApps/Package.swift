// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NanocodexApps",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "NanocodexApps", targets: ["NanocodexApps"]),
        .executable(name: "native-app-journey", targets: ["NativeAppJourney"])
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-syntax.git", exact: "602.0.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "5.0.0"),
        .package(url: "https://github.com/OpenCombine/OpenCombine.git", from: "0.14.0")
    ],
    targets: [
        .target(name: "NanocodexApps", dependencies: [
            .product(name: "SwiftSyntax", package: "swift-syntax"),
            .product(name: "SwiftParser", package: "swift-syntax"),
            .product(name: "SwiftParserDiagnostics", package: "swift-syntax"),
            .product(name: "SwiftOperators", package: "swift-syntax"),
            // Apple targets continue using CryptoKit and Combine from the SDK.
            .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux])),
            .product(name: "OpenCombine", package: "OpenCombine", condition: .when(platforms: [.linux]))
        ]),
        .executableTarget(name: "NativeAppJourney", dependencies: ["NanocodexApps"])
    ],
    swiftLanguageModes: [.v5]
)
