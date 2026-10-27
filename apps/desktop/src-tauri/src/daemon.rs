//! デーモン（turnlaned）との接続（desktop-shell.md 2.1・4.1・6.1）。
//! - トークンとポートは CLI と同じ場所から読む（TURNLANE_DATA_DIR / TURNLANE_PORT）
//! - `/api/events?client=desktop` を購読し、切れたら 1s → 30s の指数バックオフでつなぎ直す
//! - メニューバーの件数は `/api/queue/summary` を 250ms 束ねて取り直す。キューを Rust で解釈しない
//! - 通知の要否と文言はデーモンが決める（`notify` イベント）。Rust は表示するだけ（題名を直近の指示にする印だけ、出す直前に glance を読む。D-211）

use crate::{http, notify, shortcut, tray, windows, Shared};
use serde::Deserialize;
use serde_json::Value;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("TURNLANE_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(7317);
        let data_dir = std::env::var("TURNLANE_DATA_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_default();
                PathBuf::from(home).join("Library/Application Support/turnlane")
            });
        Config { port, data_dir }
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn read_token(&self) -> Option<String> {
        let t = std::fs::read_to_string(self.data_dir.join("token")).ok()?;
        let t = t.trim().to_string();
        (!t.is_empty()).then_some(t)
    }
}

#[derive(Clone, Default, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub count: u32,
    pub needs_input: u32,
    pub error: u32,
    pub your_turn: u32,
    /// 集中モード中なら表示（`集中モード中 · 16:00 まで`。D-097）
    #[serde(default)]
    pub focus: Option<FocusLabel>,
    /// メニューバーの集中モードのサブメニューの文言（ロケールはデーモン）
    #[serde(default)]
    pub focus_menu: Option<FocusMenu>,
    /// 「次の予定の終わりまで」を選べる
    #[serde(default)]
    pub focus_event_available: bool,
    /// ネイティブのメニューの文言（ロケールはデーモン。古いデーモンには無い）
    #[serde(default)]
    pub native_menu: Option<crate::menu_text::NativeMenu>,
    /// メニューバーの更新の知らせ（M6-17。新しい版が無い・dev・古いデーモンなら無い）
    #[serde(default)]
    pub update: Option<crate::menu_text::UpdateItem>,
}

#[derive(Clone, Default, Deserialize, PartialEq, Debug)]
pub struct FocusLabel {
    pub label: String,
}

#[derive(Clone, Default, Deserialize, PartialEq, Debug)]
pub struct FocusMenu {
    pub title: String,
    pub m30: String,
    pub h1: String,
    pub event: String,
    pub end: String,
}

/// 認証付きの GET / POST。401 なら Err("unauthorized")、ほかの失敗は `http <status> <error>`（error はデーモンの応答の
/// `error` の値。ログで切り分けるため）
pub fn call(app: &AppHandle, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
    let s = app.state::<Shared>();
    let token = s.st.lock().unwrap().token.clone().ok_or("no token")?;
    let body = body.map(|b| b.to_string());
    let r = http::request(s.cfg.port, method, path, &token, body.as_deref()).map_err(|e| e.to_string())?;
    match r.status {
        200..=299 => serde_json::from_str(&r.body).map_err(|e| e.to_string()),
        401 => Err("unauthorized".into()),
        n => Err(http_error(n, &r.body)),
    }
}

/// 失敗の応答の短い説明（`http 409 stale`）。本文の `error` が読めなければステータスだけ
pub fn http_error(status: u16, body: &str) -> String {
    let code = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
        .filter(|e| !e.is_empty() && e.len() <= 64 && e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'));
    match code {
        Some(c) => format!("http {status} {c}"),
        None => format!("http {status}"),
    }
}

/// SSE `focus` を受けて、出した問いの通知を取り下げるか（desktop-shell.md 3.5）: 問いが閉じ（`prompt: false`）、
/// かつ遅れた答えを受ける間（`late: true`。開始の時刻を過ぎたが予定は続く）でないとき。古いデーモンに `late` は無い
pub fn prompt_removed(data: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return false };
    let prompt = v.get("prompt").and_then(Value::as_bool);
    let late = v.get("late").and_then(Value::as_bool).unwrap_or(false);
    prompt == Some(false) && !late
}

pub fn spawn(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    let a = app.clone();
    thread::spawn(move || summary_loop(a, rx));
    thread::spawn(move || sse_loop(app, tx));
}

fn summary_loop(app: AppHandle, rx: mpsc::Receiver<()>) {
    while rx.recv().is_ok() {
        // 250ms 束ねる（desktop-shell.md 4.1）
        thread::sleep(Duration::from_millis(250));
        while rx.try_recv().is_ok() {}
        if let Ok(v) = call(&app, "GET", "/api/queue/summary", None) {
            if let Ok(sum) = serde_json::from_value::<Summary>(v) {
                let relabel = {
                    let s = app.state::<Shared>();
                    let mut st = s.st.lock().unwrap();
                    let changed = sum.native_menu.as_ref().is_some_and(|m| *m != st.menu_text);
                    if let (true, Some(m)) = (changed, sum.native_menu.clone()) {
                        st.menu_text = m;
                    }
                    st.summary = sum;
                    changed
                };
                // 言語が変わったときだけアプリのメニューを作り直す（毎回作るとちらつく）
                if relabel {
                    windows::rebuild_app_menu(&app);
                }
                tray::refresh(&app);
            }
        }
    }
}

fn set_online(app: &AppHandle, online: bool) {
    let changed = {
        let s = app.state::<Shared>();
        let mut st = s.st.lock().unwrap();
        let c = st.online != online;
        st.online = online;
        c
    };
    if changed {
        tray::refresh(app);
        if online {
            windows::on_daemon_ready(app);
        }
    }
}

/// 待つ間も Retry（boot ページ）ですぐに試し直せるようにする
fn backoff_sleep(app: &AppHandle, secs: u64) {
    let until = Instant::now() + Duration::from_secs(secs);
    let s = app.state::<Shared>();
    while Instant::now() < until {
        if s.retry.swap(false, Ordering::SeqCst) {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Attempt {
    /// トークンが無い（初めての起動でデーモンがまだ一度も動いていない）
    NoToken,
    Failed,
    Connected,
}

/// 次の試しまでの秒と、その次の間隔（純粋関数にしてテストする）。トークンが無い間はファイルを読むだけなので1秒ごとに
/// 見て、間隔を延ばさない（Welcome を読んでいる間に 30 秒まで延びると、Get started の後にデーモンが起きても最大 30 秒
/// つながらない）。トークンが出てから最初の 15 回の失敗も1秒（デーモンが HTTP を開くまでの間）。ほかは 1s → 30s
pub fn next_wait(attempt: Attempt, backoff: u64, fresh: u32) -> (u64, u64, u32) {
    match attempt {
        Attempt::NoToken => (1, 1, 15),
        Attempt::Connected => (1, 2, 0),
        Attempt::Failed if fresh > 0 => (1, 1, fresh - 1),
        Attempt::Failed => (backoff, (backoff * 2).min(30), 0),
    }
}

fn sse_loop(app: AppHandle, tx: mpsc::Sender<()>) {
    let mut backoff = 1;
    let mut fresh = 0;
    let mut ever = false;
    loop {
        let attempt = connect_once(&app, &tx);
        set_online(&app, false);
        if attempt == Attempt::Connected && !ever {
            ever = true;
            windows::log("daemon: connected");
        }
        let (wait, next, f) = next_wait(attempt, backoff, fresh);
        (backoff, fresh) = (next, f);
        backoff_sleep(&app, wait);
    }
}

/// 1回つないで切れるまで読む
fn connect_once(app: &AppHandle, tx: &mpsc::Sender<()>) -> Attempt {
    let s = app.state::<Shared>();
    // 再インストールでトークンが変わることがあるので毎回読み直す（6.1）
    let Some(token) = s.cfg.read_token() else { return Attempt::NoToken };
    let token_changed = {
        let mut st = s.st.lock().unwrap();
        let changed = st.token.as_deref() != Some(token.as_str());
        st.token = Some(token.clone());
        changed
    };
    let lang = s.st.lock().unwrap().lang.clone();
    let path = format!("/api/events?client=desktop&lang={}", http::encode(&lang));
    // ping は15秒ごと。45秒何も来なければ（スリープ復帰など）切れたとみなす
    let Ok((status, mut reader)) = http::open_stream(s.cfg.port, &path, &token, Duration::from_secs(45)) else {
        return Attempt::Failed;
    };
    if status != 200 {
        return Attempt::Failed;
    }
    if token_changed {
        // トークンが変わったら、開いているウインドウを /auth から開き直す
        s.st.lock().unwrap().online = false;
    }
    set_online(app, true);
    check_version(app);
    shortcut::sync(app);
    windows::sync_view_menu(app);
    notify::report_status(app);
    let mut parser = http::SseParser::default();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return Attempt::Connected,
            Ok(_) => {}
        }
        if let Some(ev) = parser.line(&line) {
            handle_event(app, tx, &ev.event, &ev.data);
        }
    }
}

fn handle_event(app: &AppHandle, tx: &mpsc::Sender<()>, event: &str, data: &str) {
    match event {
        // update: 更新確認の結果が変わった（メニューの更新の知らせを summary で取り直す。M6-17）
        "hello" | "follow_up" | "work_item" | "task" | "day_boundary" => {
            let _ = tx.send(());
        }
        // 自動更新（ADR 0008 の追記 4）: デーモンが新しい版を入れ終わったら（installed）、Restart to Finish Update と同じく
        // 自分を開き直す
        "update" => {
            let _ = tx.send(());
            if update_installed(data) {
                windows::log("daemon: update installed, relaunching");
                let a = app.clone();
                let _ = app.run_on_main_thread(move || crate::setup::relaunch(&a));
            }
        }
        "settings" => {
            let _ = tx.send(());
            shortcut::sync(app);
            windows::sync_view_menu(app);
        }
        "notify" => {
            if let Ok(p) = serde_json::from_str::<notify::Payload>(data) {
                for n in p.notices {
                    notify::post(app, n);
                }
            }
        }
        "desktop_notifications" => {
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(a) = v.get("action").and_then(Value::as_str) {
                    notify::on_action(app, a);
                }
            }
        }
        // 集中モード（D-097）: メニューバーを取り直し、問いが閉じたら出した通知を取り下げる（遅れた答えを受ける間は残す）
        "focus" => {
            let _ = tx.send(());
            if prompt_removed(data) {
                notify::remove_prompt();
            }
        }
        "desktop_open" => {
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(p) = v.get("path").and_then(Value::as_str) {
                    windows::open_main(app, Some(p.to_string()));
                }
            }
        }
        _ => {}
    }
}

/// デーモンとアプリの版の major.minor が違えばメニューに出す（表示だけ。6.1）
fn check_version(app: &AppHandle) {
    let Ok(h) = call(app, "GET", "/api/health", None) else { return };
    let daemon = h.get("version").and_then(Value::as_str).unwrap_or("");
    let mine = app.package_info().version.to_string();
    let mm = |v: &str| v.split('.').take(2).collect::<Vec<_>>().join(".");
    let mismatch = !daemon.is_empty() && mm(daemon) != mm(&mine);
    app.state::<Shared>().st.lock().unwrap().version_mismatch = mismatch;
    tray::refresh(app);
}

/// SSE update の中身が「入れ終わった」か（`{"installed":true,...}`）
pub fn update_installed(data: &str) -> bool {
    serde_json::from_str::<Value>(data).ok().and_then(|v| v.get("installed").and_then(Value::as_bool)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{http_error, next_wait, prompt_removed, update_installed, Attempt};

    #[test]
    fn reads_update_installed() {
        assert!(update_installed(r#"{"installed":true,"version":"0.7.2","rev":4}"#));
        assert!(!update_installed(r#"{"rev":3}"#));
        assert!(!update_installed(r#"{"installed":"yes"}"#));
        assert!(!update_installed("not json"));
    }

    #[test]
    fn waits_a_second_while_the_first_daemon_is_starting() {
        // トークンが無い間は1秒ごと（間隔を延ばさない）
        assert_eq!(next_wait(Attempt::NoToken, 30, 0), (1, 1, 15));
        // トークンが出てからの失敗（HTTP がまだ開いていない）は 15 回まで1秒
        assert_eq!(next_wait(Attempt::Failed, 1, 15), (1, 1, 14));
        assert_eq!(next_wait(Attempt::Failed, 1, 1), (1, 1, 0));
        // その後は 1s → 30s の指数バックオフ（6.1）
        assert_eq!(next_wait(Attempt::Failed, 1, 0), (1, 2, 0));
        assert_eq!(next_wait(Attempt::Failed, 16, 0), (16, 30, 0));
        assert_eq!(next_wait(Attempt::Failed, 30, 0), (30, 30, 0));
        // つながって切れたら1秒からやり直す
        assert_eq!(next_wait(Attempt::Connected, 30, 0), (1, 2, 0));
    }

    #[test]
    fn removes_the_prompt_notification_only_when_no_late_answer_is_accepted() {
        // 問いが閉じ、遅れた答えも受けない（答えた・予定が終わった）
        assert!(prompt_removed(r#"{"active":false,"prompt":false,"late":false,"rev":3}"#));
        // 開始の時刻を過ぎたが予定は続く: 通知を残す（ボタンで「予定の終わりまで集中」にできる）
        assert!(!prompt_removed(r#"{"active":false,"prompt":false,"late":true,"rev":3}"#));
        // 問いが開いている
        assert!(!prompt_removed(r#"{"active":false,"prompt":true,"late":false,"rev":3}"#));
        // 古いデーモン（late が無い）は従来どおり
        assert!(prompt_removed(r#"{"active":false,"prompt":false,"rev":3}"#));
        assert!(!prompt_removed("not json"));
    }

    #[test]
    fn describes_http_failures_with_the_daemon_error_code() {
        assert_eq!(http_error(409, r#"{"error":"stale"}"#), "http 409 stale");
        assert_eq!(http_error(400, r#"{"error":"invalid_input"}"#), "http 400 invalid_input");
        assert_eq!(http_error(500, "<html>"), "http 500");
        assert_eq!(http_error(409, r#"{"error":"has spaces"}"#), "http 409");
    }
}
