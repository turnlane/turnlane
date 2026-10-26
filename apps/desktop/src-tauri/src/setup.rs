//! 配布版の常駐の登録とアプリの配置（ADR 0011 決定 2・4、onboarding.md 2.2・4.9・5.5、M6-14・M6-15）。
//! - `SMAppService.agent`（デーモン・カレンダーヘルパ。plist は `Contents/Library/LaunchAgents/`）と `SMAppService.mainApp`
//!   （ログイン時に開く）の登録・解除・状態。呼べるのはこのアプリのプロセスだけ（バンドルを基準にする）
//! - IPC `desktop_setup`（SPA から。操作は列挙。データを読み書きしない）、フォルダの選択（O2 の Choose a folder…）、
//!   Applications への移動（B4）
//! - `Contents/Helpers/turnlaned` が無い（開発時の `bun run build:desktop`）か、TURNLANE_PORT / TURNLANE_DATA_DIR で場所を
//!   変えている（一時の環境での確認）ときは登録に触れない（バンドルの plist は署名済みで環境変数を渡せないため）
//! - 更新（M6-17、onboarding.md 2.5）: `--setup reregister <item>`（デーモンが同梱のヘルパの版の入れ替えに呼ぶ）、
//!   動いている間のバンドルの入れ替えの検出（メニューの Restart to Finish Update）と開き直し

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const DAEMON_PLIST: &str = "dev.turnlane.daemon.plist";
pub const HELPER_PLIST: &str = "dev.turnlane.calendar-helper.plist";
const APP_NAME: &str = "Turnlane.app";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    Daemon,
    CalendarHelper,
    MainApp,
}

impl Item {
    pub fn parse(s: &str) -> Option<Item> {
        match s {
            "daemon" => Some(Item::Daemon),
            "calendarHelper" => Some(Item::CalendarHelper),
            "mainApp" => Some(Item::MainApp),
            _ => None,
        }
    }
}

/// 実行ファイル（`X.app/Contents/MacOS/turnlane`）から、デーモンを同梱したバンドルの場所
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let app = exe.parent()?.parent()?.parent()?;
    (app.extension().is_some_and(|e| e == "app") && app.join("Contents/Helpers/turnlaned").exists())
        .then(|| app.to_path_buf())
}

pub fn bundle_root() -> Option<PathBuf> {
    bundle_of(&std::env::current_exe().ok()?)
}

/// 登録を扱ってよいか（同梱のバンドルで、場所を変えていない。純粋関数にしてテストする）
pub fn managed_with(bundled: bool, var: impl Fn(&str) -> Option<String>) -> bool {
    let set = |k: &str| var(k).is_some_and(|v| !v.is_empty());
    bundled && !set("TURNLANE_PORT") && !set("TURNLANE_DATA_DIR") && var("TURNLANE_NO_LAUNCHD").as_deref() != Some("1")
}

pub fn managed() -> bool {
    managed_with(bundle_root().is_some(), |k| std::env::var(k).ok())
}

/// 開発時の配置（`turnlane self-install` の LaunchAgent）が残っているか。残っていれば自動で登録しない
/// （同じラベルのエージェントが2つになる。移行は `turnlane setup migrate`。M6-16）
pub fn legacy_agent_present() -> bool {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join("Library/LaunchAgents").join(DAEMON_PLIST).exists())
        .unwrap_or(false)
}

/// Applications への移し先: /Applications に書ければそこ、だめなら ~/Applications（管理者権限を求めない）
pub fn move_destination(system_writable: bool, home: &Path) -> PathBuf {
    if system_writable {
        PathBuf::from("/Applications").join(APP_NAME)
    } else {
        home.join("Applications").join(APP_NAME)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Statuses {
    pub managed: bool,
    pub daemon: String,
    pub calendar_helper: String,
    pub main_app: String,
}

pub fn statuses() -> Statuses {
    let m = managed();
    let st = |i| if m { status(i).to_string() } else { "unmanaged".to_string() };
    Statuses { managed: m, daemon: st(Item::Daemon), calendar_helper: st(Item::CalendarHelper), main_app: st(Item::MainApp) }
}

/// 起動のたびに: 一度始めた（トークンがある）のにデーモンの登録が外れていれば登録し直す（冪等。ADR 0011 決定 5）
pub fn on_launch(first_run: bool) {
    if !managed() || first_run || legacy_agent_present() {
        return;
    }
    if status(Item::Daemon) == "notRegistered" {
        if let Err(e) = register(Item::Daemon) {
            crate::windows::log(&format!("setup: re-register daemon failed: {e}"));
        }
    }
}

/// 登録をし直してから常駐が答えるまで待つ秒（launchd が起こし、デーモンが HTTP を開くまで）
const AFTER_REREGISTER: Duration = Duration::from_secs(10);
/// 常駐を見張る処理が動いているか（起動時と Get started の後で重ねない）
static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 登録をやり直すべきか（純粋関数にしてテストする）: 前回の起動の目印（版と cdhash）が無いか、今と違う。
/// ad-hoc 署名は Team ID が無く同一性が cdhash なので、入れ替えたバンドルで古い登録のまま起こすと launchd が
/// launch constraint で殺す（2026-10-21 の Neo: SIGKILL Code Signature Invalid）。Developer ID でも更新の後の保険になる
pub fn needs_reregister(saved: Option<&str>, now: &str) -> bool {
    saved.map(str::trim) != Some(now.trim())
}

/// 今のバンドルの目印: TurnlaneBuild と cdhash（codesign -dv の CDHash=）
fn fingerprint(root: &Path) -> Option<String> {
    let build = bundle_build(root)?;
    let o = std::process::Command::new("/usr/bin/codesign").arg("-dv").arg("--verbose=4").arg(root).output().ok()?;
    let out = String::from_utf8_lossy(&o.stderr);
    let cdhash = out.lines().find_map(|l| l.strip_prefix("CDHash="))?.trim().to_string();
    Some(format!("{build} {cdhash}"))
}

fn fingerprint_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("registered-bundle.txt"))
}

/// 有効な登録（デーモン・カレンダーヘルパ）をやり直す。登録していないものには触れない
fn reregister_enabled(why: &str) {
    for (item, name) in [(Item::Daemon, "daemon"), (Item::CalendarHelper, "calendarHelper")] {
        if status(item) != "enabled" {
            continue;
        }
        match reregister(item) {
            Ok(()) => crate::windows::log(&format!("setup: re-registered {name} ({why})")),
            Err(e) => crate::windows::log(&format!("setup: re-register {name} failed ({why}): {e}")),
        }
    }
}

/// launchctl print の中から状態の行だけ（Copy diagnostics 用。パス・環境変数は出さない。純粋関数にしてテストする）
pub fn launchctl_summary(out: &str) -> Vec<String> {
    const KEYS: [&str; 6] =
        ["state =", "runs =", "last exit code =", "last terminating signal =", "immediate reason =", "job state ="];
    out.lines().map(str::trim).filter(|l| KEYS.iter().any(|k| l.starts_with(k))).map(String::from).collect()
}

/// `launchctl print gui/<uid>/<label>` の状態の行。読めなければ理由
pub fn launchctl_state(label: &str) -> String {
    let uid = std::process::Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    match std::process::Command::new("/bin/launchctl").args(["print", &format!("gui/{uid}/{label}")]).output() {
        Ok(o) if o.status.success() => {
            let l = launchctl_summary(&String::from_utf8_lossy(&o.stdout));
            if l.is_empty() { "no state lines".into() } else { l.join("; ") }
        }
        Ok(_) => "not loaded".into(),
        Err(e) => format!("launchctl failed: {e}"),
    }
}

/// 起動のたびに（別のスレッドで）: バンドルの目印が前回と違えば有効な登録をやり直し（更新・入れ替えの後の保険）、
/// 一度始めた後なら常駐を見張る
pub fn on_launch_checks(app: AppHandle, first_run: bool) {
    if !managed() || legacy_agent_present() {
        return;
    }
    std::thread::spawn(move || {
        if let (Some(root), Some(file)) = (bundle_root(), fingerprint_file(&app)) {
            if let Some(now) = fingerprint(&root) {
                let saved = std::fs::read_to_string(&file).ok();
                if needs_reregister(saved.as_deref(), &now) {
                    reregister_enabled("the app changed since the last launch");
                    let _ = std::fs::create_dir_all(file.parent().unwrap_or(&file));
                    let _ = std::fs::write(&file, &now);
                }
            }
        }
        if !first_run {
            watch_daemon(&app, Duration::from_secs(5));
        }
    });
}

/// 常駐を見張る（起動時・Get started の後）: 登録が有効なのに first_wait の間に答えなければ、登録をやり直す。
/// やり直しても答えなければ「macOS が起動を拒んでいる」として起動ページの B2 に出す（boot_state の blocked）
pub fn watch_daemon(app: &AppHandle, first_wait: Duration) {
    use std::sync::atomic::Ordering;
    if !managed() || WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Retry からやり直したときは、拒まれている表示をいったん外す
    app.state::<crate::Shared>().st.lock().unwrap().background_blocked = false;
    let online = || app.state::<crate::Shared>().st.lock().unwrap().online;
    let wait = |d: Duration| {
        let until = std::time::Instant::now() + d;
        while std::time::Instant::now() < until {
            if online() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        online()
    };
    let done = || WATCHING.store(false, Ordering::SeqCst);
    if wait(first_wait) || status(Item::Daemon) != "enabled" {
        done();
        return;
    }
    crate::windows::log(&format!(
        "setup: daemon not answering (launchd: {})",
        launchctl_state("dev.turnlane.daemon")
    ));
    reregister_enabled("the daemon did not answer");
    app.state::<crate::Shared>().retry.store(true, Ordering::SeqCst);
    if !wait(AFTER_REREGISTER) {
        crate::windows::log(&format!(
            "setup: daemon still not answering after re-registering (launchd: {})",
            launchctl_state("dev.turnlane.daemon")
        ));
        app.state::<crate::Shared>().st.lock().unwrap().background_blocked = true;
    }
    done();
}

/// O1 の Get started: デーモンを登録し、初めてならログイン時に開くも登録する（既定オン）。デーモンの状態を返す
/// 登録の結果と、かかった時間・登録の後の状態を記録に残す（初回の起動の切り分け。B2 の Copy diagnostics に載る）
pub fn get_started() -> String {
    let t0 = std::time::Instant::now();
    match register(Item::Daemon) {
        Ok(()) => crate::windows::log(&format!("setup: registered daemon in {}ms", t0.elapsed().as_millis())),
        Err(e) => crate::windows::log(&format!("setup: register daemon failed: {e}")),
    }
    if status(Item::MainApp) == "notRegistered" {
        let _ = register(Item::MainApp);
    }
    let st = status(Item::Daemon).to_string();
    crate::windows::log(&format!("setup: daemon status {st}"));
    st
}

/// B4: このバンドルを Applications へ写し、隔離の印を外して開き直す（LetsMove と同じ流儀）。移した先を返す
pub fn move_to_applications() -> Result<PathBuf, String> {
    let src = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent()?.parent()?.parent().map(Path::to_path_buf))
        .ok_or("no bundle")?;
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "no HOME")?);
    let probe = Path::new("/Applications/.turnlane-write-test");
    let writable = std::fs::write(probe, b"").is_ok();
    let _ = std::fs::remove_file(probe);
    let dst = move_destination(writable, &home);
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = dst.with_extension("app.tmp");
    let _ = std::fs::remove_dir_all(&tmp);
    let ok = std::process::Command::new("/usr/bin/ditto").arg(&src).arg(&tmp).status().map(|s| s.success());
    if !matches!(ok, Ok(true)) {
        return Err("copy failed".into());
    }
    let _ = std::fs::remove_dir_all(&dst);
    std::fs::rename(&tmp, &dst).map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&dst).status();
    let _ = std::process::Command::new("/usr/bin/open").arg("-n").arg(&dst).status();
    Ok(dst)
}

/// システム設定の画面（固定の表から選ぶ。値を SPA から受け取らない）
pub fn settings_url(pane: &str) -> Option<&'static str> {
    match pane {
        "loginItems" => Some("x-apple.systempreferences:com.apple.LoginItems-Settings.extension"),
        "calendars" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"),
        "notifications" => Some("x-apple.systempreferences:com.apple.Notifications-Settings.extension"),
        "automation" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"),
        _ => None,
    }
}

/// `Turnlane.app/Contents/MacOS/turnlane --setup status|register <item>|unregister <item>|unregister-all`
/// （`turnlane setup migrate`・`turnlane uninstall --all` が呼ぶ。Tauri を起こさずに JSON を出して終わる）
pub fn cli(args: &[String]) -> Option<i32> {
    let i = args.iter().position(|a| a == "--setup")?;
    let sub = args.get(i + 1).map(String::as_str).unwrap_or("status");
    let item = args.get(i + 2).and_then(|s| Item::parse(s));
    if !managed() {
        println!("{}", serde_json::json!({ "ok": false, "error": "unmanaged" }));
        return Some(2);
    }
    let r: Result<(), String> = match (sub, item) {
        ("status", _) => Ok(()),
        ("register", Some(it)) => register(it),
        ("unregister", Some(it)) => unregister(it),
        ("reregister", Some(it)) => reregister(it),
        ("unregister-all", _) => [Item::CalendarHelper, Item::Daemon, Item::MainApp]
            .into_iter()
            .map(unregister)
            .find(Result::is_err)
            .unwrap_or(Ok(())),
        _ => Err("usage".into()),
    };
    let s = statuses();
    println!("{}", serde_json::json!({ "ok": r.is_ok(), "error": r.err(), "status": s }));
    Some(0)
}

/// 登録をし直す（解除で launchd が今のプロセスを止め、登録で今のバンドルの plist から起こす）。登録していなければ触れない
pub fn reregister(item: Item) -> Result<(), String> {
    if status(item) != "enabled" {
        return Err("not_enabled".into());
    }
    unregister(item)?;
    let mut last = Ok(());
    for _ in 0..5 {
        last = register(item);
        if last.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    last
}

/// Info.plist（XML）の文字列の値（デーモンの plistString と同じ読み方）
pub fn plist_string(xml: &str, key: &str) -> Option<String> {
    let k = format!("<key>{key}</key>");
    let rest = xml[xml.find(&k)? + k.len()..].trim_start().strip_prefix("<string>")?;
    Some(rest[..rest.find("</string>")?].to_string())
}

/// バンドルのビルドの識別（TurnlaneBuild。無ければ CFBundleShortVersionString。デーモンの bundleBuild と同じ）
pub fn bundle_build(app: &Path) -> Option<String> {
    let xml = std::fs::read_to_string(app.join("Contents/Info.plist")).ok()?;
    plist_string(&xml, "TurnlaneBuild").or_else(|| plist_string(&xml, "CFBundleShortVersionString"))
}

/// 動いている間にバンドルが入れ替わったか（読めない間は入れ替えの途中として待つ）
pub fn bundle_replaced(started: Option<&str>, now: Option<&str>) -> bool {
    matches!((started, now), (Some(a), Some(b)) if a != b)
}

/// 配布版: 起動時のバンドルの識別を覚え、1 分ごとに見る。変わったらメニューに Restart to Finish Update を出す
pub fn watch_bundle(app: AppHandle) {
    let Some(root) = bundle_root() else { return };
    let Some(started) = bundle_build(&root) else { return };
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        if bundle_replaced(Some(&started), bundle_build(&root).as_deref()) {
            app.state::<crate::Shared>().st.lock().unwrap().update_pending = true;
            crate::tray::refresh(&app);
            return;
        }
    });
}

/// Restart to Finish Update: このプロセスが終わるのを待って同じ場所のバンドル（新しい版）を開く小さなシェルを残し、終わる
/// （単一インスタンスなので、先に開くと今のプロセスに渡ってしまう）
pub fn relaunch(app: &AppHandle) {
    let Some(root) = bundle_root() else { return };
    let spawned = std::process::Command::new("/bin/sh")
        .args(["-c", "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.2; done; /usr/bin/open \"$2\"", "sh"])
        .arg(std::process::id().to_string())
        .arg(&root)
        .spawn();
    match spawned {
        Ok(_) => app.exit(0),
        Err(e) => crate::windows::log(&format!("setup: relaunch failed: {e}")),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2::rc::Retained;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager, NSString, NSURL};
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    fn service(item: Item) -> Retained<SMAppService> {
        unsafe {
            match item {
                Item::Daemon => SMAppService::agentServiceWithPlistName(&NSString::from_str(DAEMON_PLIST)),
                Item::CalendarHelper => SMAppService::agentServiceWithPlistName(&NSString::from_str(HELPER_PLIST)),
                Item::MainApp => SMAppService::mainAppService(),
            }
        }
    }

    pub fn status(item: Item) -> &'static str {
        match unsafe { service(item).status() } {
            SMAppServiceStatus::Enabled => "enabled",
            SMAppServiceStatus::RequiresApproval => "requiresApproval",
            SMAppServiceStatus::NotFound => "notFound",
            _ => "notRegistered",
        }
    }

    pub fn register(item: Item) -> Result<(), String> {
        unsafe { service(item).registerAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    pub fn unregister(item: Item) -> Result<(), String> {
        unsafe { service(item).unregisterAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
    }

    pub fn open_login_items() {
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }

    /// ログイン項目として起動されたか（mainApp の起動。kAEOpenApplication の keyAEPropData が keyAELaunchedAsLogInItem）
    pub fn launched_at_login() -> bool {
        const KEY_AE_PROP_DATA: u32 = u32::from_be_bytes(*b"prdt");
        const LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
        let Some(ev) = NSAppleEventManager::sharedAppleEventManager().currentAppleEvent() else { return false };
        // objc2-foundation ではこの2つが objc2-core-services の機能の後ろにあるので、直接送る
        let d: Option<Retained<NSAppleEventDescriptor>> = unsafe { msg_send![&*ev, paramDescriptorForKeyword: KEY_AE_PROP_DATA] };
        d.is_some_and(|d| {
            let v: u32 = unsafe { msg_send![&*d, enumCodeValue] };
            v == LAUNCHED_AS_LOGIN_ITEM
        })
    }

    /// フォルダを選ぶ（メインスレッドで呼ぶ。隠しフォルダも出す: ~/.claude-<名前>）。選ばなければ None
    pub fn choose_folder(prompt: &str) -> Option<String> {
        let mtm = MainThreadMarker::new()?;
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(false);
        panel.setShowsHiddenFiles(true);
        panel.setCanCreateDirectories(false);
        panel.setPrompt(Some(&NSString::from_str(prompt)));
        if let Ok(h) = std::env::var("HOME") {
            panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(&h))));
        }
        if panel.runModal() != NSModalResponseOK {
            return None;
        }
        panel.URL().and_then(|u| u.path()).map(|p| p.to_string())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{choose_folder, launched_at_login, open_login_items, register, status, unregister};

#[cfg(not(target_os = "macos"))]
pub fn status(_: Item) -> &'static str {
    "unsupported"
}
#[cfg(not(target_os = "macos"))]
pub fn register(_: Item) -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(not(target_os = "macos"))]
pub fn unregister(_: Item) -> Result<(), String> {
    Err("unsupported".into())
}
#[cfg(not(target_os = "macos"))]
pub fn open_login_items() {}
#[cfg(not(target_os = "macos"))]
pub fn launched_at_login() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn choose_folder(_: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn re_registers_when_the_bundle_changed_or_was_never_seen() {
        assert!(needs_reregister(None, "0.7.0+a abc"));
        assert!(needs_reregister(Some("0.7.0+a abc"), "0.7.0+a def"));
        assert!(needs_reregister(Some("0.7.0+a abc"), "0.7.0+b abc"));
        assert!(!needs_reregister(Some("0.7.0+a abc\n"), "0.7.0+a abc"));
    }

    #[test]
    fn keeps_only_the_state_lines_of_launchctl_print() {
        let out = "gui/501/dev.turnlane.daemon = {\n\tactive count = 0\n\tpath = /Users/x/Library/LaunchAgents/a.plist\n\tstate = spawn scheduled\n\truns = 7\n\tlast exit code = 0\n\tlast terminating signal = Killed: 9\n\tenvironment = {\n\t\tHOME => /Users/x\n\t}\n}";
        assert_eq!(
            launchctl_summary(out),
            vec!["state = spawn scheduled", "runs = 7", "last exit code = 0", "last terminating signal = Killed: 9"]
        );
    }

    #[test]
    fn manages_only_the_bundled_app_in_the_default_place() {
        let none = |_: &str| None;
        assert!(managed_with(true, none));
        assert!(!managed_with(false, none));
        // 一時の環境（別のポート・データ）では登録に触れない
        assert!(!managed_with(true, |k| (k == "TURNLANE_PORT").then(|| "27317".to_string())));
        assert!(!managed_with(true, |k| (k == "TURNLANE_DATA_DIR").then(|| "/tmp/x".to_string())));
        assert!(!managed_with(true, |k| (k == "TURNLANE_NO_LAUNCHD").then(|| "1".to_string())));
        assert!(managed_with(true, |k| (k == "TURNLANE_PORT").then(String::new)));
    }

    #[test]
    fn finds_the_bundle_only_when_the_daemon_is_inside() {
        let dir = std::env::temp_dir().join(format!("turnlane-setup-{}", std::process::id()));
        let app = dir.join("Turnlane.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        let exe = app.join("Contents/MacOS/turnlane");
        assert_eq!(bundle_of(&exe), None);
        std::fs::create_dir_all(app.join("Contents/Helpers")).unwrap();
        std::fs::write(app.join("Contents/Helpers/turnlaned"), b"").unwrap();
        assert_eq!(bundle_of(&exe), Some(app.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picks_where_to_move() {
        let home = Path::new("/Users/someone");
        assert_eq!(move_destination(true, home), PathBuf::from("/Applications/Turnlane.app"));
        assert_eq!(move_destination(false, home), PathBuf::from("/Users/someone/Applications/Turnlane.app"));
    }

    #[test]
    fn notices_a_replaced_bundle() {
        let xml = "<plist><dict><key>CFBundleShortVersionString</key>\n  <string>0.7.0</string>\n<key>TurnlaneBuild</key><string>0.7.0+abc</string></dict></plist>";
        assert_eq!(plist_string(xml, "TurnlaneBuild").as_deref(), Some("0.7.0+abc"));
        assert_eq!(plist_string(xml, "CFBundleShortVersionString").as_deref(), Some("0.7.0"));
        assert_eq!(plist_string(xml, "Missing"), None);
        assert!(!bundle_replaced(Some("0.7.0+abc"), Some("0.7.0+abc")));
        // 入れ替えの途中（読めない）は待つ
        assert!(!bundle_replaced(Some("0.7.0+abc"), None));
        assert!(bundle_replaced(Some("0.7.0+abc"), Some("0.8.0+def")));
        assert!(!bundle_replaced(None, Some("0.8.0+def")));
    }

    #[test]
    fn opens_only_known_settings_panes() {
        assert!(settings_url("loginItems").is_some());
        assert!(settings_url("automation").is_some());
        assert_eq!(settings_url("x-apple.systempreferences:evil"), None);
        assert_eq!(Item::parse("daemon"), Some(Item::Daemon));
        assert_eq!(Item::parse("other"), None);
    }
}
