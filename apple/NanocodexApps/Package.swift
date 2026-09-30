// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "NanocodexApps",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "NanocodexApps", targets: ["NanocodexApps"]), .executable(name: "native-app-journey", targets: ["NativeAppJourney"])],
    dependencies: [.package(url: "https://github.com/swiftlang/swift-syntax.git", exact: "602.0.0")],
    targets: [
        .target(name: "NanocodexApps", dependencies: [.product(name: "SwiftSyntax", package: "swift-syntax"), .product(name: "SwiftParser", package: "swift-syntax"), .product(name: "SwiftParserDiagnostics", package: "swift-syntax"), .product(name: "SwiftOperators", package: "swift-syntax")]),
        .executableTarget(name: "NativeAppJourney", dependencies: ["NanocodexApps"])
    ],
    swiftLanguageModes: [.v5]
)
