//! クイック入力のグローバルホットキー（desktop-shell.md 5章、D-056 (2)）。
//! 既定は ⌥⇧Space。設定 `desktop.quick_add_shortcut` で変えられる。登録に失敗したらメニューバーのメニューに出す。

use crate::{daemon, notify, tray, windows, Shared};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

pub const DEFAULT: &str = "Alt+Shift+Space";

#[derive(Clone, Default, Debug)]
pub struct Status {
    pub accelerator: String,
    pub registered: bool,
}

pub fn handler(app: &AppHandle, _s: &Shortcut, e: ShortcutEvent) {
    if e.state() == ShortcutState::Pressed {
        windows::toggle_quick_add(app);
    }
}

/// 設定を読み、変わっていれば登録し直す（接続時と `settings` イベント）
pub fn sync(app: &AppHandle) {
    let want = daemon::call(app, "GET", "/api/config/desktop.quick_add_shortcut", None)
        .ok()
        .and_then(|v| v.get("value").and_then(Value::as_str).map(String::from))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT.to_string());
    {
        let s = app.state::<Shared>();
        let st = s.st.lock().unwrap();
        if st.shortcut.accelerator == want && st.shortcut.registered {
            return;
        }
    }
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let registered = match gs.register(want.as_str()) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("turnlane: failed to register {want}: {e}");
            false
        }
    };
    app.state::<Shared>().st.lock().unwrap().shortcut = Status { accelerator: want, registered };
    tray::refresh(app);
    notify::report_status(app);
}

/// "Alt+Shift+Space" → "⌥⇧Space"（メニューの表示用）
pub fn label(accel: &str) -> String {
    let mut out = String::new();
    for part in accel.split('+') {
        let p = part.trim();
        out.push_str(match p.to_ascii_lowercase().as_str() {
            "alt" | "option" => "⌥",
            "shift" => "⇧",
            "ctrl" | "control" => "⌃",
            "cmd" | "command" | "super" | "cmdorctrl" | "commandorcontrol" => "⌘",
            _ => p,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_accelerators() {
        assert_eq!(label("Alt+Shift+Space"), "⌥⇧Space");
        assert_eq!(label("CmdOrCtrl+Shift+K"), "⌘⇧K");
    }

    #[test]
    fn default_parses() {
        assert!(DEFAULT.parse::<Shortcut>().is_ok());
    }
}
