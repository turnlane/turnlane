//! メニューバー（desktop-shell.md 4.1・4.2）。件数は文字で出し、needs_input があれば琥珀のアイコンにする（D-037）。
//! 左クリックでポップオーバー（/tray）、右クリックでメニュー。
//! 集中モード中（D-097。desktop-shell.md 3.5）は月のアイコン（needs_input の琥珀が優先）。メニューに集中モードの
//! サブメニュー（文言はデーモンの summary の focusMenu）。ほかの項目の文言も summary の nativeMenu（menu_text.rs）。

use crate::menu_text::{self, UpdateAction, VersionNote};
use crate::{daemon, notify, shortcut, windows, Shared};
use tauri::image::Image;
use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Wry};

const ID: &str = "turnlane";
const ICON_TEMPLATE: &[u8] = include_bytes!("../icons/tray-template.png");
const ICON_NEEDS: &[u8] = include_bytes!("../icons/tray-needs.png");
const ICON_OFFLINE: &[u8] = include_bytes!("../icons/tray-offline.png");
const ICON_FOCUS: &[u8] = include_bytes!("../icons/tray-focus.png");

/// アイコンと文字（4.1 の表）。純粋関数にしてテストする
#[derive(Debug, PartialEq)]
pub enum Look {
    Offline,
    Plain(Option<u32>),
    Needs(u32),
    /// 集中モード中（件数は出す）
    Focus(Option<u32>),
}

pub fn look(online: bool, s: &crate::daemon::Summary) -> Look {
    if !online {
        Look::Offline
    } else if s.needs_input > 0 {
        Look::Needs(s.count)
    } else if s.focus.is_some() {
        Look::Focus((s.count > 0).then_some(s.count))
    } else if s.count > 0 {
        Look::Plain(Some(s.count))
    } else {
        Look::Plain(None)
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(ICON_OFFLINE)?)
        .icon_as_template(true)
        .title("–")
        .tooltip("Turnlane")
        .menu(&menu(app)?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, ev| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &ev);
            match ev {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
                    windows::toggle_tray(tray.app_handle());
                }
                TrayIconEvent::Click { button: MouseButton::Right, button_state: MouseButtonState::Down, .. } => {
                    notify::refresh_permission(tray.app_handle());
                }
                _ => {}
            }
        })
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => windows::open_main(app, None),
            "quick_add" => windows::toggle_quick_add(app),
            "notif_settings" => notify::open_settings(),
            "shortcut" => windows::open_main(app, Some("/settings#keyboard".into())),
            "start_daemon" => windows::start_daemon(app),
            "restart_update" => crate::setup::relaunch(app),
            "update_available" => on_update(app),
            "focus_30" => focus_call(app, "/api/focus/start", Some(json!({ "minutes": 30 }))),
            "focus_60" => focus_call(app, "/api/focus/start", Some(json!({ "minutes": 60 }))),
            "focus_event" => focus_call(app, "/api/focus/start", Some(json!({ "until": "event_end" }))),
            "focus_end" => focus_call(app, "/api/focus/end", None),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let st = app.state::<Shared>().st.lock().unwrap().clone();
    let t = &st.menu_text;
    let m = Menu::new(app)?;
    m.append(&MenuItem::with_id(app, "open", &t.open, true, None::<&str>)?)?;
    let key = if st.shortcut.accelerator.is_empty() { shortcut::DEFAULT } else { &st.shortcut.accelerator };
    m.append(&MenuItem::with_id(
        app,
        "quick_add",
        format!("{}  {}", t.quick_add, shortcut::label(key)),
        st.online,
        None::<&str>,
    )?)?;
    // 集中モード（D-097）。文言はデーモンから（つながっていなければ出さない）
    if let (true, Some(fm)) = (st.online, st.summary.focus_menu.as_ref()) {
        let active = st.summary.focus.is_some();
        let sub = Submenu::with_items(
            app,
            &fm.title,
            true,
            &[
                &MenuItem::with_id(app, "focus_30", &fm.m30, true, None::<&str>)?,
                &MenuItem::with_id(app, "focus_60", &fm.h1, true, None::<&str>)?,
                &MenuItem::with_id(app, "focus_event", &fm.event, st.summary.focus_event_available, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "focus_end", &fm.end, active, None::<&str>)?,
            ],
        )?;
        m.append(&sub)?;
    }
    let mut notes: Vec<MenuItem<Wry>> = vec![];
    if !st.online {
        notes.push(MenuItem::with_id(app, "offline", &t.offline, false, None::<&str>)?);
        notes.push(MenuItem::with_id(app, "start_daemon", &t.start_daemon, true, None::<&str>)?);
    }
    if st.notifications == notify::Permission::Denied {
        notes.push(MenuItem::with_id(
            app,
            "notif_settings",
            &t.notifications_off,
            true,
            None::<&str>,
        )?);
    }
    if st.online && !st.shortcut.registered && !st.shortcut.accelerator.is_empty() {
        notes.push(MenuItem::with_id(
            app,
            "shortcut",
            t.shortcut_in_use.replace("{key}", &shortcut::label(&st.shortcut.accelerator)),
            true,
            None::<&str>,
        )?);
    }
    match menu_text::version_note(st.update_pending, st.version_mismatch, st.summary.update.as_ref()) {
        VersionNote::Restart => {
            notes.push(MenuItem::with_id(app, "restart_update", &t.restart_to_update, true, None::<&str>)?);
        }
        VersionNote::Notes { mismatch, update } => {
            if mismatch {
                notes.push(MenuItem::with_id(app, "version", &t.needs_update, false, None::<&str>)?);
            }
            if let (true, Some(u)) = (update, st.summary.update.as_ref()) {
                notes.push(MenuItem::with_id(app, "update_available", &u.label, true, None::<&str>)?);
            }
        }
    }
    if !notes.is_empty() {
        m.append(&PredefinedMenuItem::separator(app)?)?;
        for n in &notes {
            m.append(n)?;
        }
    }
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&MenuItem::with_id(app, "quit", &t.quit, true, None::<&str>)?)?;
    Ok(m)
}

/// 状態からアイコン・文字・メニューを作り直す（どのスレッドから呼んでもよい）
pub fn refresh(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = a.tray_by_id(ID) else { return };
        let (online, summary, copied) = {
            let s = a.state::<Shared>();
            let st = s.st.lock().unwrap();
            let copied = st.copied_until.filter(|u| *u > Instant::now()).and(st.summary.update.as_ref()).map(|u| u.copied.clone());
            (st.online, st.summary.clone(), copied)
        };
        let (icon, template, title) = match look(online, &summary) {
            Look::Offline => (ICON_OFFLINE, true, Some("–".to_string())),
            Look::Plain(n) => (ICON_TEMPLATE, true, n.map(|n| n.to_string())),
            Look::Needs(n) => (ICON_NEEDS, false, Some(n.to_string())),
            Look::Focus(n) => (ICON_FOCUS, true, n.map(|n| n.to_string())),
        };
        let tip = summary.focus.as_ref().map_or("Turnlane".to_string(), |f| format!("Turnlane · {}", f.label));
        let _ = tray.set_tooltip(Some(tip));
        if let Ok(img) = Image::from_bytes(icon) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_icon_as_template(template);
        // 更新のコマンドを写した直後は、件数の代わりに短く「Copied」
        let _ = tray.set_title(copied.or(title));
        if let Ok(m) = menu(&a) {
            let _ = tray.set_menu(Some(m));
        }
    });
}

/// 更新の知らせ（M6-17）: homebrew はコマンドをクリップボードへ写してメニューバーに短く「Copied」、download はリリースの
/// ページを開く。ダウンロード・入れ替えはしない（ADR 0008）
fn on_update(app: &AppHandle) {
    let Some(u) = app.state::<Shared>().st.lock().unwrap().summary.update.clone() else { return };
    match menu_text::update_action(&u) {
        Some(UpdateAction::Copy(cmd)) => {
            if copy_text(cmd) {
                app.state::<Shared>().st.lock().unwrap().copied_until = Some(Instant::now() + COPIED_FOR);
                refresh(app);
                let a = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(COPIED_FOR);
                    refresh(&a);
                });
            } else {
                windows::log("tray: copying the update command failed");
            }
        }
        Some(UpdateAction::Open(url)) => {
            if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
                windows::log(&format!("tray: opening the releases page failed: {e}"));
            }
        }
        None => {}
    }
}

const COPIED_FOR: Duration = Duration::from_secs(2);

/// クリップボードへ写す（pbcopy に標準入力で渡す。シェルを通さない）
fn copy_text(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new("/usr/bin/pbcopy").stdin(Stdio::piped()).spawn() else { return false };
    let wrote = child.stdin.take().is_some_and(|mut i| i.write_all(text.as_bytes()).is_ok());
    child.wait().is_ok_and(|s| s.success()) && wrote
}

/// 集中モードの操作をデーモンへ送る（結果は SSE focus で返り、件数を取り直す）
fn focus_call(app: &AppHandle, path: &'static str, body: Option<serde_json::Value>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = daemon::call(&app, "POST", path, body.as_ref());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::Summary;

    #[test]
    fn looks() {
        let s = |count, needs_input| Summary { count, needs_input, ..Default::default() };
        assert_eq!(look(false, &s(3, 1)), Look::Offline);
        assert_eq!(look(true, &s(0, 0)), Look::Plain(None));
        assert_eq!(look(true, &s(3, 0)), Look::Plain(Some(3)));
        assert_eq!(look(true, &s(3, 1)), Look::Needs(3));
        let f = |count, needs_input| Summary {
            count,
            needs_input,
            focus: Some(crate::daemon::FocusLabel { label: "Focus · until 16:00".into() }),
            ..Default::default()
        };
        assert_eq!(look(true, &f(0, 0)), Look::Focus(None));
        assert_eq!(look(true, &f(2, 0)), Look::Focus(Some(2)));
        // needs_input の琥珀は集中中も優先する
        assert_eq!(look(true, &f(2, 1)), Look::Needs(2));
        assert_eq!(look(false, &f(2, 0)), Look::Offline);
    }

    #[test]
    fn reads_focus_from_summary() {
        let s: Summary = serde_json::from_str(
            r#"{"count":1,"needsInput":0,"error":0,"yourTurn":1,"rev":3,
                "focus":{"label":"集中 · 16:00まで"},
                "focusMenu":{"title":"集中モード","m30":"30分","h1":"1時間","event":"次の予定の終わりまで","end":"終了"},
                "focusEventAvailable":true}"#,
        )
        .unwrap();
        assert_eq!(s.focus.unwrap().label, "集中 · 16:00まで");
        assert_eq!(s.focus_menu.unwrap().event, "次の予定の終わりまで");
        assert!(s.focus_event_available);
        let old: Summary = serde_json::from_str(r#"{"count":0,"needsInput":0,"error":0,"yourTurn":0}"#).unwrap();
        assert!(old.focus.is_none() && old.focus_menu.is_none() && old.native_menu.is_none());
    }
}
