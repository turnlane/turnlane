import Foundation

/// メタデータだけのログ（ADR 0005 と同じ方針）。予定の題名・場所・参加者は書かない。
/// 1行1JSON。stdout にも出す（ターミナルから直接起動したとき用）。
final class Log {
  static var shared = Log(path: nil)

  private let handle: FileHandle?
  private let lock = NSLock()
  /// ログのファイル記述子（クラッシュのシグナルの中から write(2) で書くため）
  var fd: Int32 { handle?.fileDescriptor ?? -1 }

  init(path: String?) {
    guard let path else {
      handle = nil
      return
    }
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    if !FileManager.default.fileExists(atPath: path) {
      FileManager.default.createFile(
        atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    handle = FileHandle(forWritingAtPath: path)
    handle?.seekToEndOfFile()
  }

  func write(_ event: String, _ fields: [String: Any] = [:]) {
    var obj: [String: Any] = [
      "ts": ISO8601DateFormatter().string(from: Date()),
      "event": event,
      "pid": ProcessInfo.processInfo.processIdentifier,
    ]
    for (k, v) in fields { obj[k] = v }
    guard
      let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
      var line = String(data: data, encoding: .utf8)
    else { return }
    line += "\n"
    lock.lock()
    defer { lock.unlock() }
    if let d = line.data(using: .utf8) {
      handle?.write(d)
      FileHandle.standardOutput.write(d)
    }
  }
}

func log(_ event: String, _ fields: [String: Any] = [:]) {
  Log.shared.write(event, fields)
}

/// クラッシュの記録（2026-10-21 の Neo: 許可の後、常駐のヘルパが起動直後に終わるのを launchd が 44 回起こし直していたが、
/// 理由が残っていなかった）。捕まえていない例外は名前だけ、シグナルは番号だけを calendar-helper.log に書いてから既定の動きに戻す
/// （クラッシュレポートは macOS がそのまま作る）。予定の題名は書かない
private var crashFd: Int32 = -1
private let crashPrefix: [UInt8] = Array(#"{"event":"helper.crash","kind":"signal","signal":"#.utf8)
private let crashTail: [UInt8] = Array("}\n".utf8)

func installCrashLogging() {
  crashFd = Log.shared.fd
  NSSetUncaughtExceptionHandler { e in
    log("helper.crash", ["kind": "exception", "name": e.name.rawValue])
  }
  for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
    signal(sig) { s in
      if crashFd >= 0 {
        crashPrefix.withUnsafeBufferPointer { _ = write(crashFd, $0.baseAddress, $0.count) }
        var digits: [UInt8] = [0, 0, 0]
        var n = Int(s)
        var i = 2
        repeat {
          digits[i] = UInt8(48 + n % 10)
          n /= 10
          i -= 1
        } while n > 0 && i >= 0
        digits.withUnsafeBufferPointer { b in
          _ = write(crashFd, b.baseAddress! + i + 1, 2 - i)
        }
        crashTail.withUnsafeBufferPointer { _ = write(crashFd, $0.baseAddress, $0.count) }
      }
      signal(s, SIG_DFL)
      raise(s)
    }
  }
}
