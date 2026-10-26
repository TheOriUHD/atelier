// swift-tools-version: 6.0
// The macOS computer-use helper (docs/ARCHITECTURE.md §22): `atelier-computer`, spawned by the desktop app's main
// process and driven over computer protocol v1 (packages/protocol/src/computer.ts). Build: `pnpm computer:build`.
import PackageDescription

let package = Package(
  name: "AtelierComputer",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "atelier-computer", targets: ["atelier-computer"])],
  targets: [
    // Everything but the entry point, so the tests can reach it.
    .target(name: "AtelierComputer"),
    .executableTarget(name: "atelier-computer", dependencies: ["AtelierComputer"]),
    .testTarget(name: "AtelierComputerTests", dependencies: ["AtelierComputer"]),
  ]
)
