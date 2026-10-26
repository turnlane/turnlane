import XCTest

@testable import CalendarHelper

/// 権限の読み方を差し替えた偽物（実際の EventKit・TCC には触れない）
final class StubAuthorization: AuthorizationSource {
  var inProcessValue: String
  var freshValue: String?
  private(set) var freshReads = 0

  init(inProcess: String, fresh: String?) {
    self.inProcessValue = inProcess
    self.freshValue = fresh
  }

  func inProcess() -> String { inProcessValue }
  func fresh() -> String? {
    freshReads += 1
    return freshValue
  }
}

final class AuthorizationMonitorTests: XCTestCase {
  /// 実機の不具合（2026-10-08）の再現: 起動時は未決定。別のプロセスで許可されたが、このプロセスの中の値は
  /// 未決定のまま変わらない。以前は変化に気づかず no_access のまま同期しなかった
  func testStaleInProcessAuthorizationIsDetected() {
    let src = StubAuthorization(inProcess: "notDetermined", fresh: "notDetermined")
    let m = AuthorizationMonitor(source: src)
    XCTAssertEqual(m.check(), .unchanged)
    // 別のプロセス（turnlane calendar authorize）で許可された。このプロセスの中は古いまま
    src.freshValue = "fullAccess"
    XCTAssertEqual(m.check(), .stale(fresh: "fullAccess"))
    XCTAssertEqual(m.last, "notDetermined")
  }

  func testInProcessChangeIsReportedOnce() {
    let src = StubAuthorization(inProcess: "notDetermined", fresh: nil)
    let m = AuthorizationMonitor(source: src)
    src.inProcessValue = "fullAccess"
    XCTAssertEqual(m.check(), .changed("fullAccess"))
    XCTAssertEqual(m.check(), .unchanged)
  }

  /// フルアクセスのあいだは別のプロセスを起こさない
  func testFullAccessDoesNotSpawn() {
    let src = StubAuthorization(inProcess: "fullAccess", fresh: "denied")
    let m = AuthorizationMonitor(source: src)
    XCTAssertEqual(m.check(), .unchanged)
    XCTAssertEqual(src.freshReads, 0)
  }

  /// 読み直せない（子プロセスが失敗）なら何もしない
  func testUnreadableFreshIsIgnored() {
    let src = StubAuthorization(inProcess: "denied", fresh: nil)
    let m = AuthorizationMonitor(source: src)
    XCTAssertEqual(m.check(), .unchanged)
    XCTAssertEqual(src.freshReads, 1)
  }

  /// 拒否のまま（別のプロセスでも拒否）なら起動し直さない
  func testDeniedEverywhereIsUnchanged() {
    let src = StubAuthorization(inProcess: "denied", fresh: "denied")
    XCTAssertEqual(AuthorizationMonitor(source: src).check(), .unchanged)
  }

  func testRelaunchNeedsUptime() {
    XCTAssertFalse(shouldRelaunch(uptime: 5, minUptime: 60))
    XCTAssertTrue(shouldRelaunch(uptime: 60, minUptime: 60))
  }

  func testParseAuthorization() {
    XCTAssertEqual(parseAuthorization("fullAccess"), "fullAccess")
    XCTAssertNil(parseAuthorization(""))
    XCTAssertNil(parseAuthorization("granted"))
  }

  /// --fake-auth-file は起動時に1回だけ読む（古いまま残る）。読み直しは子プロセス
  func testFakeAuthorizationCachesFile() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let f = dir.appendingPathComponent("auth").path
    try "notDetermined".write(toFile: f, atomically: true, encoding: .utf8)
    let a = FakeAuthorization(file: f, sub: nil)
    try "fullAccess".write(toFile: f, atomically: true, encoding: .utf8)
    XCTAssertEqual(a.inProcess(), "notDetermined")
    XCTAssertEqual(FakeAuthorization.read(f), "fullAccess")
  }
}
