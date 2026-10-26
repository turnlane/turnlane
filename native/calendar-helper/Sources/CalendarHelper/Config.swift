import Foundation

/// 起動の設定（引数と環境変数）。既定はデーモンと同じ配置（phase0-plan 1.4）:
/// - トークン: $TURNLANE_DATA_DIR/token（既定 ~/Library/Application Support/turnlane/token）
/// - ポート: $TURNLANE_PORT（既定 7317）
/// - ログ: $TURNLANE_LOG_DIR/calendar-helper.log（既定 ~/Library/Logs/turnlane/）
enum Mode: String {
  /// 常駐（LaunchAgent）。デーモンへ WebSocket で接続し、要求に応える
  case run
  /// 権限のダイアログを出して結果を記録し、終了する（turnlane calendar authorize、S1）
  case authorize
  /// S1 の確認用: 権限の状態と、カレンダー・予定の件数（題名は出さない）を記録して終了する
  case probe
  /// 起動できること・バンドルの情報だけを記録して終了する（EventKit に触れない。自動の確認用）
  case selfTest = "self-test"
}

struct HelperConfig {
  var mode: Mode = .run
  var port: Int = 7317
  var tokenPath: String
  var logPath: String
  /// EventKit の代わりに固定のダミーの予定を返す（EventKit・TCC に触れない。自動の確認用）
  var fakeStore = false
  /// --fake-store でカレンダーを 1 つも返さない（アカウントの無い Mac の確かめ用）
  var fakeEmpty = false
  /// probe: storeChanged を待つ秒数（0 なら待たない）
  var watchSeconds = 0
  /// --fake-store の権限を書いたファイル（D-130 の確かめ用。起動時に1回だけ読み、プロセスの中で古いまま残るのを再現する）
  var fakeAuthFile: String?
  /// 権限が古いと分かったとき、起動からこの秒数たっていれば起動し直す（D-130。起動し直しが続かないように）
  var minUptimeForRelaunch: TimeInterval = 60

  static func from(arguments: [String], environment: [String: String]) -> HelperConfig {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let dataDir =
      nonEmpty(environment["TURNLANE_DATA_DIR"]) ?? "\(home)/Library/Application Support/turnlane"
    let logDir = nonEmpty(environment["TURNLANE_LOG_DIR"]) ?? "\(home)/Library/Logs/turnlane"
    var c = HelperConfig(
      tokenPath: "\(dataDir)/token",
      logPath: "\(logDir)/calendar-helper.log"
    )
    if let p = nonEmpty(environment["TURNLANE_PORT"]), let n = Int(p) { c.port = n }
    var i = 1
    func value() -> String? {
      i += 1
      return i < arguments.count ? arguments[i] : nil
    }
    while i < arguments.count {
      switch arguments[i] {
      case "--authorize": c.mode = .authorize
      case "--probe": c.mode = .probe
      case "--self-test": c.mode = .selfTest
      case "--fake-store": c.fakeStore = true
      case "--fake-empty": c.fakeEmpty = true
      case "--port": if let v = value(), let n = Int(v) { c.port = n }
      case "--token-file": if let v = value() { c.tokenPath = v }
      case "--log": if let v = value() { c.logPath = v }
      case "--watch": if let v = value(), let n = Int(v) { c.watchSeconds = n }
      case "--fake-auth-file": if let v = value() { c.fakeAuthFile = v }
      case "--min-uptime": if let v = value(), let n = Double(v) { c.minUptimeForRelaunch = n }
      default: break  // LaunchServices が付ける -psn_... などは無視する
      }
      i += 1
    }
    return c
  }

  private static func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
  }
}

enum HelperInfo {
  static var version: String {
    Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0-dev"
  }
  static var bundleId: String { Bundle.main.bundleIdentifier ?? "(none)" }
}
