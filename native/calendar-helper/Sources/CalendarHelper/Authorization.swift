import Foundation

/// カレンダーの権限の読み方（D-130）。テストでは差し替える。
///
/// 常駐のヘルパは起動したときの権限（たとえば「未決定」）をプロセスの中で覚えたままになることがある。
/// 別のプロセス（`turnlane calendar authorize` が開いたヘルパ）で許可しても、常駐のヘルパの
/// `EKEventStore.authorizationStatus` は古いまま返り、予定を取れない（no_access）状態が続いた（2026-10-08 の実機）。
/// そこで、フルアクセスでないあいだは別のプロセスで読み直し、食い違っていればヘルパを起動し直す。
protocol AuthorizationSource {
  /// このプロセスの中で見た権限（"fullAccess" | "denied" | "notDetermined" | "writeOnly"）
  func inProcess() -> String
  /// 別のプロセスで読み直した権限。読めなければ nil
  func fresh() -> String?
}

/// 権限の確かめの結果
enum AuthorizationCheck: Equatable {
  /// 変わっていない
  case unchanged
  /// このプロセスの中の値が変わった（EKEventStore を作り直して知らせる）
  case changed(String)
  /// このプロセスの中の値が古い（別のプロセスでは fresh）。起動し直す
  case stale(fresh: String)
}

/// 権限の変化を見る（30秒ごと・storeChanged・status の要求のたび）
final class AuthorizationMonitor {
  private let source: AuthorizationSource
  private(set) var last: String

  init(source: AuthorizationSource) {
    self.source = source
    self.last = source.inProcess()
  }

  func check() -> AuthorizationCheck {
    let a = source.inProcess()
    if a != last {
      last = a
      return .changed(a)
    }
    // フルアクセスなら読み直さない（別のプロセスを起こすのはフルアクセスでないあいだだけ）
    if a == "fullAccess" { return .unchanged }
    guard let f = source.fresh(), f != a else { return .unchanged }
    return .stale(fresh: f)
  }
}

/// 起動し直してよいか（起動し直しが続かないよう、起動から minUptime 秒たってから）
func shouldRelaunch(uptime: TimeInterval, minUptime: TimeInterval = 60) -> Bool {
  uptime >= minUptime
}

/// 自分の実行ファイルを `--auth-status` で起動して権限を読む（子プロセスの TCC の帰属先はヘルパ自身。
/// 新しいプロセスなので、このプロセスの中に残った古い値の影響を受けない）
struct SubprocessAuthorization {
  let executable: URL
  let extraArgs: [String]
  var timeout: TimeInterval = 5

  func read() -> String? {
    let p = Process()
    p.executableURL = executable
    p.arguments = ["--auth-status"] + extraArgs
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(timeout)
    while p.isRunning && Date() < deadline { usleep(20_000) }
    if p.isRunning {
      p.terminate()
      return nil
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return parseAuthorization(s)
  }
}

/// `--auth-status` の出力（1行）を権限の値にする。知らない値は nil
func parseAuthorization(_ s: String) -> String? {
  ["fullAccess", "denied", "notDetermined", "writeOnly"].contains(s) ? s : nil
}

/// EventKit の権限（常駐の既定）
struct EventKitAuthorization: AuthorizationSource {
  let sub: SubprocessAuthorization?
  func inProcess() -> String { EventKitStore.authorizationString() }
  func fresh() -> String? { sub?.read() }
}

/// --fake-store の権限。--fake-auth-file があれば起動時に1回だけ読んで覚える（実機の「古いまま」を再現する）。
/// 読み直しは子プロセス（同じ引数の --auth-status）がファイルを読み直す
final class FakeAuthorization: AuthorizationSource {
  private let cached: String
  private let sub: SubprocessAuthorization?

  init(file: String?, sub: SubprocessAuthorization?) {
    self.cached = FakeAuthorization.read(file) ?? "fullAccess"
    self.sub = file == nil ? nil : sub
  }

  static func read(_ file: String?) -> String? {
    guard let file, let s = try? String(contentsOfFile: file, encoding: .utf8) else { return nil }
    return parseAuthorization(s.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  func inProcess() -> String { cached }
  func fresh() -> String? { sub?.read() }
}
