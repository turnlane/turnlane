//! ウインドウ（desktop-shell.md 2.5・2.7）: main / tray（ポップオーバー）/ quick-add。
//! - どれもデーモンが配信する SPA を `/auth?t=<token>&next=<path>` から読み込む（クッキー認証。ADR 0010）
//! - デーモンの外へ出るナビゲーションは既定のブラウザに渡す
//! - main を閉じたら webview ごと破棄し、Dock と ⌘Tab から消す（D-056 (1)）

use crate::{daemon, http, Shared};
use serde_json::Value;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{
    ActivationPolicy, AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_positioner::{Position, WindowExt};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const MAIN: &str = "main";
const TRAY: &str = "tray";
const QUICK: &str = "quick-add";
pub const DEFAULT_PATH: &str = "/board";

fn ua(app: &AppHandle) -> String {
    format!("{UA} TurnlaneDesktop/{}", app.package_info().version)
}

/// WKWebView の中で開いてよい URL（デーモンと同梱の boot ページだけ）
pub fn allowed(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(port),
        "tauri" => url.host_str() == Some("localhost"),
        "about" => true,
        _ => false,
    }
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// アプリ内のパスだけを許す（オープンリダイレクト対策。デーモンの safeNext と同じ規則）
pub fn safe_path(p: &str) -> Option<&str> {
    (p.starts_with('/') && !p.starts_with("//") && !p.contains('\\')).then_some(p)
}

fn auth_url(app: &AppHandle, path: &str) -> Option<Url> {
    let s = app.state::<Shared>();
    let st = s.st.lock().unwrap();
    let token = st.token.as_ref().filter(|_| st.online)?;
    let next = safe_path(path).unwrap_or(DEFAULT_PATH);
    Url::parse(&format!("{}/auth?t={}&next={}", s.cfg.origin(), http::encode(token), http::encode(next))).ok()
}

fn builder<'a>(app: &'a AppHandle, label: &'a str, url: WebviewUrl) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let port = app.state::<Shared>().cfg.port;
    WebviewWindowBuilder::new(app, label, url)
        .user_agent(&ua(app))
        .disable_drag_drop_handler()
        .on_navigation(move |u| {
            let ok = allowed(u, port);
            if !ok {
                open_external(u);
            }
            ok
        })
        .on_new_window(move |u, _| {
            open_external(&u);
            NewWindowResponse::Deny
        })
}

// ---- main ----

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Geometry {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn geometry_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load_geometry(app: &AppHandle) -> Option<Geometry> {
    serde_json::from_str(&std::fs::read_to_string(geometry_file(app)?).ok()?).ok()
}

fn save_geometry(w: &WebviewWindow) {
    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor()) else { return };
    let (p, s) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    let g = Geometry { x: p.x, y: p.y, w: s.width, h: s.height };
    if let Some(f) = geometry_file(w.app_handle()) {
        let _ = std::fs::create_dir_all(f.parent().unwrap_or(&f));
        let _ = std::fs::write(f, serde_json::to_string(&g).unwrap_or_default());
    }
}

/// main を出して path の画面へ移る（どのスレッドから呼んでもよい）
pub fn open_main(app: &AppHandle, path: Option<String>) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || open_main_now(&a, path.as_deref()));
}

fn open_main_now(app: &AppHandle, path: Option<&str>) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window(MAIN) {
        if let Some(p) = path.and_then(safe_path) {
            navigate_main(app, &w, p);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let s = app.state::<Shared>();
    let p = path
        .and_then(safe_path)
        .map(String::from)
        .or_else(|| s.st.lock().unwrap().last_path.clone())
        .unwrap_or_else(|| DEFAULT_PATH.into());
    let (url, seed) = match auth_url(app, &p) {
        Some(u) => (WebviewUrl::External(u), None),
        None => {
            s.st.lock().unwrap().last_path = Some(p.clone());
            (WebviewUrl::App("index.html".into()), Some(boot_seed_script(&boot_state_now(app, false))))
        }
    };
    let g = load_geometry(app);
    let mut b = builder(app, MAIN, url).on_page_load(|_, p| {
        // どのページを読み終えたか（黒い画面の切り分け。トークンは残さない）
        if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
            log(&format!("main: loaded {}", page_label(p.url())));
        }
    });
    // boot ページは IPC の答えを待たずに最初の画面（Welcome・つながらない画面）を描く。IPC がメインスレッドの仕事の
    // 後ろで待たされても黒いままにしない
    if let Some(js) = seed {
        b = b.initialization_script(js);
    }
    let mut b = b
        .title("Turnlane")
        .inner_size(g.map_or(1280.0, |g| g.w), g.map_or(800.0, |g| g.h))
        // 最小の幅は 1024（狭い幅の規則の前提。D-193 B-1）。高さは今のまま
        .min_inner_size(1024.0, 600.0)
        .focused(true);
    b = match g {
        Some(g) => b.position(g.x, g.y),
        None => b.center(),
    };
    let Ok(w) = b.build() else { return };
    let w2 = w.clone();
    w.on_window_event(move |e| match e {
        WindowEvent::CloseRequested { .. } => {
            // 最後の画面を覚えて、次に開いたときに戻す
            if let Ok(u) = w2.url() {
                if u.scheme() == "http" {
                    let q = u.query().map(|q| format!("?{q}")).unwrap_or_default();
                    w2.state::<Shared>().st.lock().unwrap().last_path = Some(format!("{}{q}", u.path()));
                }
            }
            save_geometry(&w2);
        }
        // システム設定で通知の許可を変えて戻ってきたときのために読み直す（D-080）
        WindowEvent::Focused(true) => crate::notify::refresh_permission(w2.app_handle()),
        WindowEvent::Destroyed => {
            // 閉じたら Dock と ⌘Tab から消してメニューバーだけに残す（D-056 (1)）
            let _ = w2.app_handle().set_activation_policy(ActivationPolicy::Accessory);
        }
        _ => {}
    });
    let _ = w.set_focus();
}

fn navigate_main(app: &AppHandle, w: &WebviewWindow, path: &str) {
    let on_boot = w.url().map(|u| u.scheme() != "http").unwrap_or(true);
    if on_boot {
        if let Some(u) = auth_url(app, path) {
            let _ = w.navigate(u);
        }
        return;
    }
    // SPA の中で移る（main.tsx が window.__turnlaneOpen を置く）。無ければ読み込み直す
    let p = serde_json::to_string(path).unwrap_or_default();
    let _ = w.eval(format!("window.__turnlaneOpen ? window.__turnlaneOpen({p}) : location.assign({p})"));
}

/// デーモンにつながった（つなぎ直した）とき: boot ページを出していれば SPA へ、tray / quick-add を作り直す
pub fn on_daemon_ready(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = a.get_webview_window(MAIN) {
            let on_boot = w.url().map(|u| u.scheme() != "http").unwrap_or(true);
            let path = a.state::<Shared>().st.lock().unwrap().last_path.clone();
            if on_boot {
                if let Some(u) = auth_url(&a, path.as_deref().unwrap_or(DEFAULT_PATH)) {
                    let _ = w.navigate(u);
                }
            }
        }
        for (label, path) in [(TRAY, "/tray"), (QUICK, "/quick-add")] {
            let Some(url) = auth_url(&a, path) else { continue };
            if let Some(w) = a.get_webview_window(label) {
                let _ = w.navigate(url);
            } else {
                let _ = build_aux(&a, label, url);
            }
        }
    });
}

/// 隠しておく小さなウインドウ（すぐ開くため。8章）
fn build_aux(app: &AppHandle, label: &str, url: Url) -> tauri::Result<()> {
    let (w, h) = if label == TRAY { (360.0, 480.0) } else { (640.0, 168.0) };
    let win = builder(app, label, WebviewUrl::External(url))
        .title("Turnlane")
        .inner_size(w, h)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(true)
        .visible_on_all_workspaces(label == QUICK)
        .build()?;
    let w2 = win.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Focused(false) = e {
            let _ = w2.hide();
            // メニューバーのアイコンをクリックして閉じたとき、続くクリックで開き直さないため
            w2.state::<Shared>().st.lock().unwrap().aux_hidden_at = Some(Instant::now());
        }
    });
    Ok(())
}

pub fn toggle_tray(app: &AppHandle) {
    let Some(w) = app.get_webview_window(TRAY) else { return };
    let just_hidden = app.state::<Shared>().st.lock().unwrap().aux_hidden_at.is_some_and(|t| t.elapsed().as_millis() < 300);
    if w.is_visible().unwrap_or(false) || just_hidden {
        let _ = w.hide();
        return;
    }
    let _ = w.move_window(Position::TrayBottomCenter);
    let _ = w.show();
    let _ = w.set_focus();
}

pub fn toggle_quick_add(app: &AppHandle) {
    let t0 = Instant::now();
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = a.get_webview_window(QUICK) else { return };
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            hide_quick_add(&a, &w);
            return;
        }
        a.state::<Shared>().st.lock().unwrap().return_focus = other_app_frontmost();
        // カーソルのある画面の上から 1/3 の中央に置く
        if let Ok(c) = a.cursor_position() {
            if let Ok(Some(m)) = a.monitor_from_point(c.x, c.y) {
                let s = m.scale_factor();
                let (mp, ms) = (m.position().to_logical::<f64>(s), m.size().to_logical::<f64>(s));
                let size = w.outer_size().map(|z| z.to_logical::<f64>(s)).unwrap_or(LogicalSize::new(640.0, 168.0));
                let _ = w.set_position(LogicalPosition::new(
                    mp.x + (ms.width - size.width) / 2.0,
                    mp.y + ms.height / 3.0 - size.height / 2.0,
                ));
            }
        }
        let _ = w.show();
        let _ = w.set_focus();
        trace(&format!("quick-add shown in {:.1}ms", t0.elapsed().as_secs_f64() * 1000.0));
    });
}

fn hide_quick_add(app: &AppHandle, w: &WebviewWindow) {
    let _ = w.hide();
    // 直前のアプリにフォーカスを返す（Turnlane が前面だったときは返さない）
    if app.state::<Shared>().st.lock().unwrap().return_focus {
        let _ = app.hide();
    }
}

#[cfg(target_os = "macos")]
fn other_app_frontmost() -> bool {
    use objc2_app_kit::NSWorkspace;
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|a| a.processIdentifier() != std::process::id() as i32)
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn other_app_frontmost() -> bool {
    false
}

/// TURNLANE_DESKTOP_TRACE=1 のときだけ標準エラーに出す（確認用。データや本文は出さない）
pub fn trace(msg: &str) {
    if std::env::var_os("TURNLANE_DESKTOP_TRACE").is_some() {
        eprintln!("turnlane: {msg}");
    }
}

/// 常に stderr（LaunchAgent なら ~/Library/Logs/turnlane/desktop.stderr.log）に残す記録。操作の結果の切り分けに使う。
/// 予定の題名・通知の本文は書かない。Finder から開いたときは stderr がどこにも残らないので、直近の分を覚えて
/// B2 の Copy diagnostics に添える（起動からの経過の秒を付ける）
pub fn log(msg: &str) {
    eprintln!("turnlane: {msg}");
    let line = format!("+{:.1}s {msg}", started().elapsed().as_secs_f64());
    let mut l = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if l.len() >= LOG_KEEP {
        l.remove(0);
    }
    l.push(line);
}

const LOG_KEEP: usize = 40;
static LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// アプリの起動の時刻（main の最初で呼ぶ）
pub fn started() -> Instant {
    *STARTED.get_or_init(Instant::now)
}

/// 覚えている記録（Copy diagnostics の先頭）
pub fn recent_log() -> Vec<String> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 常駐を起こす（boot ページの Get started・Start Turnlane、メニューバーの Start Turnlane）。SMAppService の登録と
/// launchctl は別のスレッドで動かす（メニューのイベントはメインスレッドで来るので、待つとウインドウが止まる）
pub fn start_daemon(app: &AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || start_daemon_now(&a));
}

fn start_daemon_now(app: &AppHandle) {
    // 配布版: 登録が無ければ登録する（登録すると launchd が起こす）
    if crate::setup::managed() && crate::setup::status(crate::setup::Item::Daemon) != "enabled" {
        crate::setup::get_started();
        app.state::<Shared>().retry.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::setup::watch_daemon(app, std::time::Duration::from_secs(5));
        return;
    }
    let uid = std::process::Command::new("id").arg("-u").output();
    if let Ok(o) = uid {
        let uid = String::from_utf8_lossy(&o.stdout).trim().to_string();
        let _ = std::process::Command::new("launchctl")
            .args(["kickstart", &format!("gui/{uid}/dev.turnlane.daemon")])
            .status();
    }
    app.state::<Shared>().retry.store(true, std::sync::atomic::Ordering::SeqCst);
    // 登録が有効なのに起きなければ登録をやり直す（ad-hoc の入れ替えで古い登録が launch constraint に当たる）
    crate::setup::watch_daemon(app, std::time::Duration::from_secs(5));
}

// ---- web から呼ぶコマンド（リモート URL には desktop_hide / desktop_open / desktop_quick_add だけを開く） ----

#[tauri::command]
pub fn desktop_hide(app: AppHandle, window: WebviewWindow) {
    match window.label() {
        QUICK => hide_quick_add(&app, &window),
        _ => {
            let _ = window.hide();
        }
    }
}

/// メニューバーの「タスクを追加」: ポップオーバーを隠してクイック入力（⌥⇧Space と同じ）を開く（D-113）
#[tauri::command]
pub fn desktop_quick_add(app: AppHandle, window: WebviewWindow) {
    if window.label() != MAIN && window.label() != QUICK {
        let _ = window.hide();
    }
    toggle_quick_add(&app);
}

#[tauri::command]
pub fn desktop_open(app: AppHandle, window: WebviewWindow, path: String) {
    trace(&format!("desktop_open from {}: {path}", window.label()));
    if window.label() != MAIN {
        let _ = window.hide();
    }
    open_main(&app, Some(path));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootState {
    online: bool,
    port: u16,
    /// 初めての起動（デーモンが一度も動いていない: トークンが無い）。boot ページは Welcome（O1）を出す
    first_run: bool,
    /// 常駐の登録の状態（SMAppService。配布版だけ。開発時の配置は None）。`requiresApproval` なら B1
    background: Option<String>,
    /// ダウンロードフォルダ・ディスクイメージから開いた（App Translocation。B4。onboarding.md 4.9）
    translocated: bool,
    /// 登録をやり直しても常駐が答えない（macOS が起動を拒んでいる。B2 の文を替える）
    blocked: bool,
}

/// App Translocation（読み取り専用の一時の場所）か、ディスクイメージの中から開いたか
fn translocated() -> bool {
    std::env::current_exe()
        .map(|p| {
            let s = p.to_string_lossy();
            s.contains("/AppTranslocation/") || s.starts_with("/Volumes/")
        })
        .unwrap_or(false)
}

/// boot ページの状態。with_background のときだけ常駐の登録の状態（SMAppService に問い合わせる）を足す
fn boot_state_now(app: &AppHandle, with_background: bool) -> BootState {
    let s = app.state::<Shared>();
    let (online, blocked) = {
        let st = s.st.lock().unwrap();
        (st.online, st.background_blocked)
    };
    let background = (with_background && crate::setup::managed()).then(|| {
        let t0 = Instant::now();
        let st = crate::setup::status(crate::setup::Item::Daemon).to_string();
        let ms = t0.elapsed().as_millis();
        // 遅い問い合わせだけ残す（初回の起動の切り分け）
        if ms >= 500 {
            log(&format!("setup: daemon status {st} took {ms}ms"));
        }
        st
    });
    BootState { online, port: s.cfg.port, first_run: s.cfg.read_token().is_none(), background, translocated: translocated(), blocked }
}

/// boot ページに渡す初めの状態（`window.__turnlaneBootSeed`）。値は真偽とポートだけ
pub fn boot_seed_script(st: &BootState) -> String {
    format!("window.__turnlaneBootSeed = {};", serde_json::to_string(st).unwrap_or_else(|_| "null".into()))
}

/// 非同期のコマンドにして、メインスレッドで動かさない（SMAppService の問い合わせが遅くてもウインドウを止めない）
#[tauri::command]
pub async fn boot_state(app: AppHandle) -> BootState {
    boot_state_now(&app, true)
}

/// B1: システム設定のログイン項目を開く
#[tauri::command]
pub fn boot_open_login_items() {
    if crate::setup::managed() {
        crate::setup::open_login_items();
        return;
    }
    if let Some(u) = crate::setup::settings_url("loginItems") {
        let _ = tauri_plugin_opener::open_url(u, None::<&str>);
    }
}

/// B4: Applications へ移して開き直す（移せたらこのアプリは終わる）
#[tauri::command]
pub fn boot_move_to_applications(app: AppHandle) -> Result<String, String> {
    let dst = crate::setup::move_to_applications()?;
    log(&format!("setup: moved to {}", dst.display()));
    app.exit(0);
    Ok(dst.display().to_string())
}

/// SPA から（onboarding.md 5.5）。操作は列挙で、データを読み書きしない:
/// status / registerCalendarHelper / unregisterCalendarHelper / setOpenAtLogin { on } / openSettings { pane } /
/// chooseFolder（O2 の Choose a folder…。選んだパスか null）。同期のコマンドなのでメインスレッドで動く（フォルダの選択の
/// モーダルに要る）
#[tauri::command]
pub fn desktop_setup(
    app: AppHandle,
    action: String,
    on: Option<bool>,
    pane: Option<String>,
    prompt: Option<String>,
) -> Result<Value, String> {
    use crate::setup::{self, Item};
    let need_managed = || if setup::managed() { Ok(()) } else { Err("unmanaged".to_string()) };
    let out = match action.as_str() {
        "status" => Value::Null,
        "registerCalendarHelper" => {
            need_managed()?;
            // 既に有効なら解除して登録し直す（カレンダーの許可の後のつなぎ直し。古い登録が launch constraint に当たる
            // 場合も今のバンドルから起こし直す）。有効でなければ登録する
            if setup::status(Item::CalendarHelper) == "enabled" {
                setup::reregister(Item::CalendarHelper)?;
            } else {
                setup::register(Item::CalendarHelper)?;
            }
            Value::Null
        }
        "unregisterCalendarHelper" => {
            need_managed()?;
            setup::unregister(Item::CalendarHelper)?;
            Value::Null
        }
        "setOpenAtLogin" => {
            need_managed()?;
            if on.unwrap_or(true) { setup::register(Item::MainApp)? } else { setup::unregister(Item::MainApp)? }
            Value::Null
        }
        "openSettings" => {
            let url = setup::settings_url(pane.as_deref().unwrap_or("")).ok_or("unknown_pane")?;
            let _ = tauri_plugin_opener::open_url(url, None::<&str>);
            Value::Null
        }
        "chooseFolder" => {
            let p = setup::choose_folder(prompt.as_deref().unwrap_or("Choose"));
            serde_json::json!({ "path": p })
        }
        _ => return Err("unknown_action".into()),
    };
    crate::notify::report_status(&app);
    let mut st = serde_json::to_value(setup::statuses()).unwrap_or(Value::Null);
    if let (Value::Object(m), Value::Object(extra)) = (&mut st, out) {
        m.extend(extra);
    }
    Ok(st)
}

/// B2: `turnlane doctor --redact` の出力（会話の本文を含まない。ADR 0016）。同梱の turnlane、無ければ ~/.local/bin
#[tauri::command]
pub async fn boot_diagnostics() -> String {
    let mut head = String::from("desktop:\n");
    for l in recent_log() {
        head.push_str(&format!("  {l}\n"));
    }
    // launchd から見た常駐の状態（launch constraint で殺されていれば runs が増え、最後のシグナルが残る）
    if crate::setup::managed() {
        head.push_str("launchd:\n");
        for label in ["dev.turnlane.daemon", "dev.turnlane.calendar-helper"] {
            head.push_str(&format!("  {label}: {}\n", crate::setup::launchctl_state(label)));
        }
    }
    format!("{head}\n{}", doctor_redacted())
}

fn doctor_redacted() -> String {
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("../Helpers/turnlane"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        cands.push(std::path::PathBuf::from(home).join(".local/bin/turnlane"));
    }
    for c in cands {
        if !c.exists() {
            continue;
        }
        if let Ok(o) = std::process::Command::new(&c).args(["doctor", "--redact"]).output() {
            return String::from_utf8_lossy(&o.stdout).into_owned();
        }
    }
    "turnlane doctor --redact: turnlane was not found".to_string()
}

/// 起動ページの JS が動いたこと・JS の失敗を記録に残す（ターミナルから開けば stderr、Copy diagnostics の先頭）。
/// 黒い画面の切り分け（JS が動かないのか、描いたものが出ないのか）。1 行、長さを切る
#[tauri::command]
pub fn boot_report(line: String) {
    log(&format!("boot page: {}", one_line(&line, 300)));
}

/// 改行を空白にし、max 文字で切る
pub fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flat.chars().count() <= max {
        return flat;
    }
    let mut t: String = flat.chars().take(max).collect();
    t.push('…');
    t
}

/// 読み込んだページの場所（記録用）。クエリ（/auth の t= のトークン）と断片を落とす
pub fn page_label(url: &Url) -> String {
    format!("{}://{}{}", url.scheme(), url.host_str().unwrap_or(""), url.path())
}

#[tauri::command]
pub fn boot_start_daemon(app: AppHandle) {
    start_daemon(&app);
}

#[tauri::command]
pub fn boot_retry(app: AppHandle) {
    app.state::<Shared>().retry.store(true, std::sync::atomic::Ordering::SeqCst);
}

// ---- アプリのメニュー（2.5） ----
// Undo / Redo は既定の項目（PredefinedMenuItem）にしない: WKWebView ではメニューのキーが web の keydown より先に取るので、
// 既定の項目だと入力欄の外の ⌘Z（タスクの操作の取り消し）までネイティブの取り消しになる。自前の項目にして web の
// `window.__turnlaneEdit` を呼び、入力欄の中なら文字の取り消し、外なら ⌘Z を画面に渡す（apps/web/src/lib/editable.ts）。
// 項目が無いと入力欄の中の ⌘Z・⇧⌘Z がどこにも届かない
// 文言は State.menu_text（デーモンの nativeMenu。menu_text.rs）。言語が変わったら作り直す

pub fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let (t, accels) = match app.try_state::<Shared>() {
        Some(s) => {
            let st = s.st.lock().unwrap();
            (st.menu_text.clone(), st.view_accels.clone())
        }
        None => (crate::menu_text::NativeMenu::default(), None),
    };
    let accels = accels.unwrap_or_else(|| view_accelerators(&Value::Null));
    let accel = |id: &str| accels.iter().find(|(m, _)| *m == id).and_then(|(_, a)| a.clone());
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Turnlane",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&t.app.about), None)?,
            &sep()?,
            &MenuItem::with_id(app, "settings", &t.app.settings, true, Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(&t.app.hide))?,
            &PredefinedMenuItem::hide_others(app, Some(&t.app.hide_others))?,
            &PredefinedMenuItem::show_all(app, Some(&t.app.show_all))?,
            &sep()?,
            &MenuItem::with_id(app, "quit", &t.quit, true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        &t.edit.title,
        true,
        &[
            &MenuItem::with_id(app, "edit_undo", &t.edit.undo, true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "edit_redo", &t.edit.redo, true, Some("CmdOrCtrl+Shift+Z"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some(&t.edit.cut))?,
            &PredefinedMenuItem::copy(app, Some(&t.edit.copy))?,
            &PredefinedMenuItem::paste(app, Some(&t.edit.paste))?,
            &PredefinedMenuItem::select_all(app, Some(&t.edit.select_all))?,
        ],
    )?;
    let view = Submenu::with_id_and_items(
        app,
        "view",
        &t.view.title,
        true,
        &[
            // ビューの切り替え（D-075）。WKWebView ではメニューのキーが web の keydown より先に取る
            &MenuItem::with_id(app, "view_three", &t.view.three, true, accel("view_three"))?,
            &MenuItem::with_id(app, "view_week", &t.view.week, true, accel("view_week"))?,
            &MenuItem::with_id(app, "view_day", &t.view.day, true, accel("view_day"))?,
            &sep()?,
            &MenuItem::with_id(app, "reload", &t.view.reload, true, Some("CmdOrCtrl+R"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        &t.window.title,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&t.window.minimize))?,
            &PredefinedMenuItem::close_window(app, Some(&t.window.close))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

/// デーモンから受け取った文言が変わったら、アプリのメニューを作り直す（表示メニューのキーは State から付け直す）
pub fn rebuild_app_menu(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || match app_menu(&a) {
        Ok(m) => {
            if let Err(e) = a.set_menu(m) {
                eprintln!("turnlane: failed to set the app menu: {e}");
            }
        }
        Err(e) => eprintln!("turnlane: failed to build the app menu: {e}"),
    });
}

/// 表示メニューの項目 → キーマップの id と既定のキー（D-077。web の keymap.ts）
const VIEW_KEYS: [(&str, &str, &str); 3] = [
    ("view_three", "viewThree", "CmdOrCtrl+1"),
    ("view_week", "viewWeek", "CmdOrCtrl+2"),
    ("view_day", "viewDay", "CmdOrCtrl+3"),
];

/// web のキーの表記（`mod+1`・`mod+shift+k`）→ メニューのアクセラレータ。⌘ の無いキー・2打鍵・記号は None
/// （メニューに載せず、web の keydown が受ける）
pub fn accel_of(spec: &str) -> Option<String> {
    if spec.contains(' ') {
        return None;
    }
    let mut parts: Vec<&str> = spec.split('+').collect();
    let key = parts.pop()?;
    if !parts.contains(&"mod") {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for m in &parts {
        out.push(
            match *m {
                "mod" => "CmdOrCtrl",
                "shift" => "Shift",
                "alt" => "Alt",
                _ => return None,
            }
            .to_string(),
        );
    }
    let k = match key {
        "enter" => "Enter".to_string(),
        "backspace" => "Backspace".to_string(),
        "space" => "Space".to_string(),
        "arrowup" => "ArrowUp".to_string(),
        "arrowdown" => "ArrowDown".to_string(),
        "arrowleft" => "ArrowLeft".to_string(),
        "arrowright" => "ArrowRight".to_string(),
        "\\" => "Backslash".to_string(),
        k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => k.to_ascii_uppercase(),
        _ => return None,
    };
    out.push(k);
    Some(out.join("+"))
}

/// 設定 `ui.keybindings`（id → キーの配列。無い id は既定）から、表示メニューの各項目のアクセラレータを決める
pub fn view_accelerators(bindings: &Value) -> Vec<(&'static str, Option<String>)> {
    VIEW_KEYS
        .iter()
        .map(|(menu, id, default)| {
            let accel = match bindings.get(*id).and_then(Value::as_array) {
                None => Some((*default).to_string()),
                Some(keys) => keys.iter().filter_map(Value::as_str).find_map(accel_of),
            };
            (*menu, accel)
        })
        .collect()
}

/// 表示メニューの ⌘1〜⌘3 を設定のキーに合わせる（接続時と `settings` イベント。D-077）
pub fn sync_view_menu(app: &AppHandle) {
    let bindings = daemon::call(app, "GET", "/api/config/ui.keybindings", None)
        .ok()
        .and_then(|v| v.get("value").cloned())
        .unwrap_or(Value::Null);
    let accels = view_accelerators(&bindings);
    app.state::<Shared>().st.lock().unwrap().view_accels = Some(accels.clone());
    let Some(menu) = app.menu() else { return };
    let Some(view) = menu.get("view").and_then(|k| k.as_submenu().cloned()) else { return };
    for (id, accel) in accels {
        if let Some(item) = view.get(id).and_then(|k| k.as_menuitem().cloned()) {
            if let Err(e) = item.set_accelerator(accel.as_deref()) {
                eprintln!("turnlane: failed to set accelerator for {id}: {e}");
            }
        }
    }
}

/// 表示メニューの項目 → web の `__turnlaneView` の引数と、SPA がまだ無いときに開く path（D-075）
fn view_of(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        "view_three" => Some(("three", "/board")),
        "view_week" => Some(("week", "/board")),
        "view_day" => Some(("day", "/day")),
        _ => None,
    }
}

fn switch_view(app: &AppHandle, view: &str, path: &str) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let on_boot = w.url().map(|u| u.scheme() != "http").unwrap_or(true);
        if !on_boot {
            let v = serde_json::to_string(view).unwrap_or_default();
            let p = serde_json::to_string(path).unwrap_or_default();
            let _ = w.eval(format!("window.__turnlaneView ? window.__turnlaneView({v}) : location.assign({p})"));
            return;
        }
    }
    open_main(app, Some(path.into()));
}

/// Edit メニューの項目 → web の `__turnlaneEdit` の引数
fn edit_of(id: &str) -> Option<&'static str> {
    match id {
        "edit_undo" => Some("undo"),
        "edit_redo" => Some("redo"),
        _ => None,
    }
}

/// 取り消し・やり直しを、いま前にあるウインドウ（本体・クイック入力・メニューバー）の SPA に渡す。起動中の画面では何もしない
fn edit_command(app: &AppHandle, cmd: &str) {
    let focused = [MAIN, QUICK, TRAY]
        .iter()
        .filter_map(|l| app.get_webview_window(l))
        .find(|w| w.is_focused().unwrap_or(false));
    if let Some(w) = focused {
        let c = serde_json::to_string(cmd).unwrap_or_default();
        let _ = w.eval(format!("window.__turnlaneEdit && window.__turnlaneEdit({c})"));
    }
}

pub fn on_menu_event(app: &AppHandle, e: MenuEvent) {
    if let Some((view, path)) = view_of(e.id().as_ref()) {
        switch_view(app, view, path);
        return;
    }
    if let Some(cmd) = edit_of(e.id().as_ref()) {
        edit_command(app, cmd);
        return;
    }
    match e.id().as_ref() {
        "settings" => open_main(app, Some("/settings".into())),
        "reload" => {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.reload();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_the_page_without_the_token() {
        let u = Url::parse("http://127.0.0.1:7317/auth?t=secret&next=%2Fboard#x").unwrap();
        assert_eq!(page_label(&u), "http://127.0.0.1/auth");
        assert_eq!(page_label(&Url::parse("tauri://localhost/index.html").unwrap()), "tauri://localhost/index.html");
    }

    #[test]
    fn keeps_boot_reports_on_one_short_line() {
        assert_eq!(one_line("a\nb\tc", 10), "a b c");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }

    #[test]
    fn allows_only_the_daemon_and_the_boot_page() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(allowed(&u("http://127.0.0.1:7317/board"), 7317));
        assert!(allowed(&u("http://localhost:7317/"), 7317));
        assert!(allowed(&u("tauri://localhost/index.html"), 7317));
        assert!(!allowed(&u("http://127.0.0.1:8080/"), 7317));
        assert!(!allowed(&u("https://github.com/x/y/pull/1"), 7317));
        assert!(!allowed(&u("http://example.com:7317/"), 7317));
    }

    #[test]
    fn converts_web_keys_to_accelerators() {
        assert_eq!(accel_of("mod+1").as_deref(), Some("CmdOrCtrl+1"));
        assert_eq!(accel_of("mod+shift+k").as_deref(), Some("CmdOrCtrl+Shift+K"));
        assert_eq!(accel_of("mod+alt+enter").as_deref(), Some("CmdOrCtrl+Alt+Enter"));
        assert_eq!(accel_of("mod+\\").as_deref(), Some("CmdOrCtrl+Backslash"));
        assert_eq!(accel_of("g w"), None);
        assert_eq!(accel_of("w"), None);
        assert_eq!(accel_of("shift+j"), None);
        assert_eq!(accel_of("mod+!"), None);
        for s in ["mod+1", "mod+shift+k", "mod+alt+enter", "mod+\\"] {
            let a = accel_of(s).unwrap();
            assert!(a.parse::<tauri_plugin_global_shortcut::Shortcut>().is_ok(), "{a}");
        }
    }

    #[test]
    fn view_menu_follows_keybindings() {
        // 上書きなし → 既定の ⌘1〜⌘3
        let d = view_accelerators(&Value::Null);
        assert_eq!(d[0], ("view_three", Some("CmdOrCtrl+1".to_string())));
        assert_eq!(d[2], ("view_day", Some("CmdOrCtrl+3".to_string())));
        // 3日を ⌘⇧1 に、週は g w だけ（メニューのキーなし）、日はそのまま
        let b = serde_json::json!({ "viewThree": ["mod+shift+1"], "viewWeek": ["g w"] });
        let v = view_accelerators(&b);
        assert_eq!(v[0].1.as_deref(), Some("CmdOrCtrl+Shift+1"));
        assert_eq!(v[1].1, None);
        assert_eq!(v[2].1.as_deref(), Some("CmdOrCtrl+3"));
    }

    #[test]
    fn maps_view_menu_items() {
        assert_eq!(view_of("view_three"), Some(("three", "/board")));
        assert_eq!(view_of("view_week"), Some(("week", "/board")));
        assert_eq!(view_of("view_day"), Some(("day", "/day")));
        assert_eq!(view_of("reload"), None);
    }

    #[test]
    fn maps_edit_menu_items() {
        assert_eq!(edit_of("edit_undo"), Some("undo"));
        assert_eq!(edit_of("edit_redo"), Some("redo"));
        assert_eq!(edit_of("view_three"), None);
    }

    #[test]
    fn accepts_only_in_app_paths() {
        assert_eq!(safe_path("/queue?item=a"), Some("/queue?item=a"));
        assert_eq!(safe_path("//evil.example"), None);
        assert_eq!(safe_path("https://evil.example"), None);
        assert_eq!(safe_path("/a\\b"), None);
    }
}

