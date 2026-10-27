//! Turnlane のデスクトップシェル（Tauri 2。ADR 0010、docs/spec/desktop-shell.md）。
//! デーモン（turnlaned）のクライアントとして、SPA の表示・メニューバー・ネイティブ通知・グローバルホットキーだけを持つ。
//! データ・判定・文言はデーモンが持つ。Rust に判定を書かない。

mod daemon;
mod http;
mod menu_text;
mod notify;
mod setup;
mod shortcut;
mod tray;
mod windows;

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Instant;
use tauri::ipc::CapabilityBuilder;
use tauri::{ActivationPolicy, Manager, RunEvent};

pub struct Shared {
    pub cfg: daemon::Config,
    pub st: Mutex<State>,
    /// boot ページの Retry・Start Turnlane で、バックオフを待たずにつなぎ直す
    pub retry: AtomicBool,
}

#[derive(Default, Clone)]
pub struct State {
    pub online: bool,
    pub token: Option<String>,
    pub lang: String,
    pub summary: daemon::Summary,
    /// ネイティブのメニューの文言（最後にデーモンから受け取ったもの。つながる前は macOS の優先言語の代わりの文言）
    pub menu_text: menu_text::NativeMenu,
    /// 表示メニューの ⌘1〜⌘3（設定のキー。アプリのメニューを作り直すときに付け直す。None なら既定）
    pub view_accels: Option<Vec<(&'static str, Option<String>)>>,
    pub notifications: notify::Permission,
    pub shortcut: shortcut::Status,
    pub version_mismatch: bool,
    /// 動いている間にバンドルが入れ替わった（更新の後。メニューに Restart to Finish Update。M6-17）
    pub update_pending: bool,
    /// 更新のコマンドを写した直後（メニューバーの文字を短く「Copied」にする。M6-17）
    pub copied_until: Option<Instant>,
    /// main を閉じたときの画面（次に開くときに戻す）
    pub last_path: Option<String>,
    /// クイック入力を閉じたら直前のアプリへフォーカスを返すか
    pub return_focus: bool,
    pub aux_hidden_at: Option<Instant>,
    /// 登録をやり直しても常駐が答えない（macOS が起動を拒んでいる。起動ページの B2 に出す）
    pub background_blocked: bool,
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).cloned()
}

/// macOS の優先言語（通知の文言のロケール。設定 ui.language が system のとき。3.2）
fn preferred_language() -> String {
    #[cfg(target_os = "macos")]
    {
        let langs = objc2_foundation::NSLocale::preferredLanguages();
        if let Some(l) = langs.firstObject() {
            return l.to_string();
        }
    }
    "en".into()
}

fn main() {
    windows::started();
    let args: Vec<String> = std::env::args().collect();
    // `--setup …`（turnlane setup migrate・uninstall --all が呼ぶ）: SMAppService の登録だけをして終わる（M6-14）
    if let Some(code) = setup::cli(&args) {
        std::process::exit(code);
    }
    // LaunchAgent からの起動（ログイン時）はメニューバーだけで始める
    let background = args.iter().any(|a| a == "--background");
    let start_path = arg_value(&args, "--path");
    let cfg = daemon::Config::from_env();
    let port = cfg.port;

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            windows::open_main(app, arg_value(&args, "--path"));
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(shortcut::handler).build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shared {
            cfg,
            st: Mutex::new({
                let lang = preferred_language();
                State { menu_text: menu_text::fallback(&lang), lang, ..Default::default() }
            }),
            retry: AtomicBool::new(false),
        })
        .menu(windows::app_menu)
        .on_menu_event(windows::on_menu_event)
        .invoke_handler(tauri::generate_handler![
            windows::desktop_hide,
            windows::desktop_open,
            windows::desktop_quick_add,
            windows::desktop_setup,
            windows::boot_state,
            windows::boot_start_daemon,
            windows::boot_retry,
            windows::boot_open_login_items,
            windows::boot_diagnostics,
            windows::boot_move_to_applications,
            windows::boot_report
        ])
        .setup(move |app| {
            // デーモンの SPA（リモート URL）に開くのは desktop_hide / desktop_open / desktop_quick_add / desktop_setup だけ（7章）
            app.add_capability(
                CapabilityBuilder::new("remote")
                    .remote(format!("http://127.0.0.1:{port}/*"))
                    .remote(format!("http://localhost:{port}/*"))
                    .windows(["main", "tray", "quick-add"])
                    .permission("allow-desktop-hide")
                    .permission("allow-desktop-open")
                    .permission("allow-desktop-quick-add")
                    .permission("allow-desktop-setup"),
            )?;
            let h = app.handle();
            tray::create(h)?;
            notify::init(h);
            daemon::spawn(h.clone());
            // 配布版: 一度始めた後に登録が外れていれば登録し直す（M6-14）。ログイン項目として開かれたらメニューバーだけ
            let first_run = app.state::<Shared>().cfg.read_token().is_none();
            setup::on_launch(first_run);
            // 版・署名が変わっていれば登録をやり直す。一度始めた後で、登録はあるのに常駐が答えなければ登録をやり直し、
            // それでも答えなければ起動ページに出す（launch constraint で殺される ad-hoc の入れ替えなど）
            setup::on_launch_checks(h.clone(), first_run);
            setup::watch_bundle(h.clone());
            if background || setup::launched_at_login() {
                app.set_activation_policy(ActivationPolicy::Accessory);
            } else {
                windows::open_main(h, start_path.clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Turnlane desktop app");

    app.run(|app, ev| match ev {
        // Dock のアイコンのクリック
        RunEvent::Reopen { .. } => windows::open_main(app, None),
        // ウインドウをすべて閉じても終了しない（⌘Q とメニューの Quit だけで終わる）
        RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
        _ => {}
    });
}
