// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ModKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15)
    ],
    products: [
        .library(name: "ModKit", targets: ["ModKit"])
    ],
    targets: [
        .target(
            name: "ModKit",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(name: "ModKitTests", dependencies: ["ModKit"])
    ]
)
