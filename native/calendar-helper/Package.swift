// swift-tools-version:5.9
// TurnlaneCalendarHelper（phase0-plan 1.5、ADR 0003）。EventKit を読む LSUIElement の小さなアプリ。
// .app への組み立てと署名は scripts/build-app.sh が行う。
import PackageDescription

let package = Package(
  name: "CalendarHelper",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "CalendarHelper",
      path: "Sources/CalendarHelper",
      linkerSettings: [
        .linkedFramework("EventKit"),
        .linkedFramework("AppKit"),
      ]
    ),
    // 権限の読み直し（D-130）など、EventKit・TCC に触れない部分のテスト（swift test）
    .testTarget(
      name: "CalendarHelperTests",
      dependencies: ["CalendarHelper"],
      path: "Tests/CalendarHelperTests"
    ),
  ]
)
