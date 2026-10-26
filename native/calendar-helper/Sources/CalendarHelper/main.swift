// TurnlaneCalendarHelper のエントリ（phase0-plan 1.5、ADR 0003、S1）。
//
//   TurnlaneCalendarHelper                 常駐（LaunchAgent）。デーモンへ接続して要求に応える
//   TurnlaneCalendarHelper --authorize     権限のダイアログを出し、結果を記録して終了
//   TurnlaneCalendarHelper --probe [--watch 60]
//                                         権限と件数（題名は出さない）を記録して終了（S1 の確認）
//   TurnlaneCalendarHelper --self-test     起動とバンドル情報だけを記録して終了（EventKit に触れない）
//   TurnlaneCalendarHelper --version
//   TurnlaneCalendarHelper --auth-status   権限を1行で出して終了（常駐のヘルパが読み直しに使う。D-130）
//
// 共通: --port <n> / --token-file <path> / --log <path> / --fake-store [--fake-auth-file <path>] / --min-uptime <秒>
// TCC の権限は「責任のあるプロセス」に付くので、権限を確かめるときは Terminal から直接ではなく、
// open（LaunchServices）か launchd から起動する（docs/spikes/s1-eventkit-tcc.md）。
import AppKit
import EventKit
import Foundation

if CommandLine.arguments.contains("--version") {
  print("TurnlaneCalendarHelper \(HelperInfo.version)")
  exit(0)
}

let config = HelperConfig.from(
  arguments: CommandLine.arguments, environment: ProcessInfo.processInfo.environment)

// 権限を読み直す子プロセス（D-130）。NSApplication もログも作らずに1行だけ出す
if CommandLine.arguments.contains("--auth-status") {
  print(
    config.fakeStore
      ? (FakeAuthorization.read(config.fakeAuthFile) ?? "fullAccess")
      : EventKitStore.authorizationString())
  exit(0)
}

Log.shared = Log(path: config.logPath)
installCrashLogging()
let launchedAt = Date()

final class AppDelegate: NSObject, NSApplicationDelegate {
  let config: HelperConfig
  var bridge: Bridge?
  var store: CalendarStore?

  init(config: HelperConfig) { self.config = config }

  func applicationDidFinishLaunching(_ notification: Notification) {
    log(
      "helper.started",
      [
        "mode": config.mode.rawValue, "version": HelperInfo.version,
        "bundle_id": HelperInfo.bundleId, "fake_store": config.fakeStore,
        "parent_pid": getppid(),
      ])
    switch config.mode {
    case .selfTest: selfTest()
    case .authorize: authorize()
    case .probe: probe()
    case .run: run()
    }
  }

  private func makeStore() -> CalendarStore {
    config.fakeStore
      ? FakeStore(
        authorization: FakeAuthorization.read(config.fakeAuthFile) ?? "fullAccess",
        empty: config.fakeEmpty)
      : EventKitStore()
  }

  /// 権限の読み方（常駐。別のプロセスでの読み直しは自分の実行ファイルの --auth-status）
  private func makeAuthorizationSource() -> AuthorizationSource {
    let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    if config.fakeStore {
      var args = ["--fake-store"]
      if let f = config.fakeAuthFile { args += ["--fake-auth-file", f] }
      return FakeAuthorization(
        file: config.fakeAuthFile, sub: SubprocessAuthorization(executable: exe, extraArgs: args))
    }
    return EventKitAuthorization(sub: SubprocessAuthorization(executable: exe, extraArgs: []))
  }

  private func finish(_ code: Int32) {
    log("helper.exit", ["code": Int(code)])
    exit(code)
  }

  private func selfTest() {
    let info = Bundle.main.infoDictionary ?? [:]
    log(
      "helper.self_test",
      [
        "bundle_id": HelperInfo.bundleId,
        "bundle_path": Bundle.main.bundlePath.hasSuffix(".app") ? "app" : "bare",
        "ls_ui_element": (info["LSUIElement"] as? Bool) ?? false,
        "has_full_access_usage":
          ((info["NSCalendarsFullAccessUsageDescription"] as? String)?.isEmpty == false),
        "activation_policy": NSApp.activationPolicy() == .accessory ? "accessory" : "other",
      ])
    finish(0)
  }

  private func authorize() {
    if config.fakeStore {
      finish(0)
      return
    }
    let s = EventKitStore()
    store = s
    let before = s.authorization()
    log("authorize.before", ["authorization": before])
    if before == "fullAccess" {
      finish(0)
      return
    }
    // ダイアログが前に出るよう、一時的に通常のアプリとして前面に出る
    NSApp.setActivationPolicy(.regular)
    // macOS 14 以降は activate(ignoringOtherApps:) が効かないことがある（Neo: active:false のまま）。新しい API も呼ぶ
    if #available(macOS 14.0, *) { NSApp.activate() }
    NSApp.activate(ignoringOtherApps: true)
    // ダイアログが出ずに戻ったときの手がかり（2026-10-21 の Neo）: 前面にいたか、EventKit の error の domain と code
    log("authorize.request", ["active": NSApp.isActive])
    s.requestFullAccess { granted, error in
      let e = error.map { $0 as NSError }
      log(
        "authorize.result",
        [
          "granted": granted, "authorization": EventKitStore.authorizationString(),
          "error": e?.code ?? NSNull(), "error_domain": e?.domain ?? NSNull(),
          "active": NSApp.isActive,
        ])
      self.finish(granted ? 0 : 1)
    }
  }

  private func probe() {
    let s = makeStore()
    store = s
    let a = s.authorization()
    var fields: [String: Any] = ["authorization": a]
    if a == "fullAccess" {
      let cals = s.listCalendars()
      let ids = cals.compactMap { $0["id"] as? String }
      let now = Date()
      let events = s.fetchEvents(
        calendarIds: ids, from: now.addingTimeInterval(-7 * 86400),
        to: now.addingTimeInterval(21 * 86400))
      fields["calendars"] = cals.count
      fields["events_window"] = events.count
      fields["all_day_events"] = events.filter { ($0["allDay"] as? Bool) == true }.count
      fields["read_only_calendars"] = cals.filter { ($0["allowsModify"] as? Bool) == false }.count
    }
    log("probe.result", fields)
    if config.watchSeconds <= 0 || a != "fullAccess" {
      finish(a == "fullAccess" ? 0 : 2)
      return
    }
    var changes = 0
    s.onStoreChanged = {
      changes += 1
      log("probe.store_changed", ["count": changes])
    }
    log("probe.watching", ["seconds": config.watchSeconds])
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(config.watchSeconds)) {
      log("probe.watch_done", ["store_changed": changes])
      self.finish(0)
    }
  }

  private func run() {
    let s = makeStore()
    store = s
    // 起動直後に終わるときの手がかり: このプロセスの中の権限
    log("run.started", ["authorization": s.authorization()])
    let monitor = AuthorizationMonitor(source: makeAuthorizationSource())
    let b = Bridge(config: config, store: s, monitor: monitor) { [config] fresh in
      // このプロセスの中の権限が古い（D-130）。起動し直せば launchd（KeepAlive）が新しいプロセスで起こす
      let uptime = Date().timeIntervalSince(launchedAt)
      guard shouldRelaunch(uptime: uptime, minUptime: config.minUptimeForRelaunch) else {
        log("helper.relaunch_skipped", ["uptime_s": Int(uptime)])
        return
      }
      log("helper.relaunch", ["reason": "authorization_stale", "fresh": fresh])
      // 応答を送り終えてから終わる
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(300)) {
        log("helper.exit", ["code": 75])
        exit(75)
      }
    }
    bridge = b
    b.start()
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate(config: config)
app.delegate = delegate
app.run()
