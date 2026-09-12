// swift-tools-version: 6.2

import PackageDescription

let package = Package(
	name: "EnduragentCoach",
	platforms: [
		.iOS(.v26),
		.macOS(.v15),
	],
	products: [
		.library(name: "EnduragentCoach", targets: ["EnduragentCoach"]),
	],
	targets: [
		.target(name: "EnduragentCoach"),
		.testTarget(
			name: "EnduragentCoachTests",
			dependencies: ["EnduragentCoach"],
			resources: [.copy("Fixtures")]
		),
	],
	swiftLanguageModes: [.v6]
)
