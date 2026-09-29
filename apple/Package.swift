// swift-tools-version: 6.0
// Run scripts/prepare-xtool.py: Xcode owns membership and dependency versions.
import Foundation
import PackageDescription

struct Staging: Decodable {
    struct Dependency: Decodable {
        let identity: String
        let path: String?
        let url: String?
        let version: String?
    }
    struct Target: Decodable {
        struct Product: Decodable { let name: String; let package: String }
        let name: String
        let product: String
        let dependencies: [Product]
        let defines: [String]
        let extensionTarget: Bool
        let linkerFlags: [String]
    }
    let deploymentTarget: String
    let dependencies: [Dependency]
    let targets: [Target]
}
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
guard let data = try? Data(contentsOf: root.appendingPathComponent("xtool/generated/package.json")),
      let staging = try? JSONDecoder().decode(Staging.self, from: data) else {
    fatalError("Run python3 apple/scripts/prepare-xtool.py from the repository root first.")
}
let package = Package(
    name: "Nanocodex",
    platforms: [.iOS(staging.deploymentTarget)],
    // xtool's native SwiftPM backend turns automatic libraries into executables.
    products: staging.targets.map { .library(name: $0.product, targets: [$0.name]) },
    dependencies: staging.dependencies.map {
        if let path = $0.path { return .package(path: path) }
        return .package(url: $0.url!, exact: Version($0.version!)!)
    },
    targets: staging.targets.map { target in
        .target(
            name: target.name,
            dependencies: target.dependencies.map { .product(name: $0.name, package: $0.package) },
            path: "xtool/generated/Sources/\(target.name)",
            swiftSettings: target.defines.map { .define($0) } +
                (target.extensionTarget ? [.unsafeFlags(["-application-extension"])] : []),
            linkerSettings: [.unsafeFlags(target.linkerFlags)]
        )
    },
    swiftLanguageModes: [.v5]
)
