//! ネイティブのメニュー（メニューバーの右クリックとアプリのメニュー）の文言（desktop-shell.md 2.5・4.2）。
//! 正はデーモン（ADR 0010。packages/core の NATIVE_MENU を /api/queue/summary の nativeMenu で受け取る）。
//! 受け取った文言は State に残し、デーモンが止まっても使い続ける。ここの表は、起動してから一度もつながっていない間
//! （デーモンが止まっている・起動の途中）にだけ使う代わりの文言で、macOS の優先言語で選ぶ。

use serde::Deserialize;

#[derive(Clone, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenu {
    pub open: String,
    pub quick_add: String,
    pub offline: String,
    pub start_daemon: String,
    pub notifications_off: String,
    /// `{key}` をクイック入力のキーの表記に置き換える
    pub shortcut_in_use: String,
    pub needs_update: String,
    /// 更新の後にアプリを開き直す（M6-17）。古いデーモンは返さないので代わりの文言
    #[serde(default = "restart_to_update_en")]
    pub restart_to_update: String,
    pub quit: String,
    pub app: AppText,
    pub edit: EditText,
    pub view: ViewText,
    pub window: WindowText,
}

#[derive(Clone, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppText {
    pub about: String,
    pub settings: String,
    pub hide: String,
    pub hide_others: String,
    pub show_all: String,
}

#[derive(Clone, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditText {
    pub title: String,
    /// 取り消す・やり直す（入力欄の中は文字、外は操作の取り消し。windows.rs）。古いデーモンは返さないので代わりの文言
    #[serde(default = "undo_en")]
    pub undo: String,
    #[serde(default = "redo_en")]
    pub redo: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
}

#[derive(Clone, Deserialize, PartialEq, Debug)]
pub struct ViewText {
    pub title: String,
    pub three: String,
    pub week: String,
    pub day: String,
    pub reload: String,
}

#[derive(Clone, Deserialize, PartialEq, Debug)]
pub struct WindowText {
    pub title: String,
    pub minimize: String,
    pub close: String,
}

impl Default for NativeMenu {
    fn default() -> Self {
        fallback("en")
    }
}

fn restart_to_update_en() -> String {
    "Restart to Finish Update".into()
}

fn undo_en() -> String {
    "Undo".into()
}

fn redo_en() -> String {
    "Redo".into()
}

/// メニューバーの更新の知らせ（M6-17。/api/queue/summary の update。文言と行き先はデーモン。古いデーモンには無い）
#[derive(Clone, Deserialize, PartialEq, Debug)]
pub struct UpdateItem {
    pub label: String,
    /// copy（コマンドをクリップボードへ）か open（リリースのページを開く）
    pub action: String,
    pub value: String,
    /// 写した直後にメニューバーに短く出す文言
    pub copied: String,
}

/// 押したときにすること（受け取った値を確かめる。決まった形のコマンドと GitHub のページだけ）
#[derive(PartialEq, Debug)]
pub enum UpdateAction<'a> {
    Copy(&'a str),
    Open(&'a str),
}

pub fn update_action(u: &UpdateItem) -> Option<UpdateAction<'_>> {
    let v = u.value.as_str();
    let one_line = !v.is_empty() && v.len() <= 200 && !v.contains(['\n', '\r']);
    match u.action.as_str() {
        "copy" if one_line && v.starts_with("brew upgrade ") => Some(UpdateAction::Copy(v)),
        "open" if one_line && v.starts_with("https://github.com/") => Some(UpdateAction::Open(v)),
        _ => None,
    }
}

/// メニューの版の項目（desktop-shell.md 6.1）。Restart to Finish Update ＞ 更新の知らせ。版のずれ（dev の self-install）は
/// Restart の代わりに出さないだけで、更新の知らせと並ぶ
#[derive(PartialEq, Debug)]
pub enum VersionNote {
    Restart,
    Notes { mismatch: bool, update: bool },
}

pub fn version_note(update_pending: bool, version_mismatch: bool, update: Option<&UpdateItem>) -> VersionNote {
    if update_pending {
        VersionNote::Restart
    } else {
        VersionNote::Notes { mismatch: version_mismatch, update: update.is_some_and(|u| update_action(u).is_some()) }
    }
}

/// つながる前の代わりの文言（`lang` は macOS の優先言語。`ja` で始まれば日本語）
pub fn fallback(lang: &str) -> NativeMenu {
    let s = |x: &str| x.to_string();
    if lang.to_ascii_lowercase().starts_with("ja") {
        NativeMenu {
            open: s("Turnlane を開く"),
            quick_add: s("クイック入力"),
            offline: s("Turnlane がバックグラウンドで動いていません"),
            start_daemon: s("Turnlane を起動"),
            notifications_off: s("通知がオフです · システム設定を開く"),
            shortcut_in_use: s("{key} は使用中です · 変更"),
            needs_update: s("アプリの更新が必要です · turnlane self-install を実行"),
            restart_to_update: s("再起動して更新を終える"),
            quit: s("Turnlane を終了"),
            app: AppText {
                about: s("Turnlane について"),
                settings: s("設定…"),
                hide: s("Turnlane を隠す"),
                hide_others: s("ほかを隠す"),
                show_all: s("すべてを表示"),
            },
            edit: EditText {
                title: s("編集"),
                undo: s("取り消す"),
                redo: s("やり直す"),
                cut: s("カット"),
                copy: s("コピー"),
                paste: s("ペースト"),
                select_all: s("すべてを選択"),
            },
            view: ViewText { title: s("表示"), three: s("3日"), week: s("週"), day: s("デイビュー"), reload: s("再読み込み") },
            window: WindowText { title: s("ウインドウ"), minimize: s("しまう"), close: s("ウインドウを閉じる") },
        }
    } else {
        NativeMenu {
            open: s("Open Turnlane"),
            quick_add: s("Quick Add"),
            offline: s("Turnlane isn't running in the background"),
            start_daemon: s("Start Turnlane"),
            notifications_off: s("Notifications are off · Open System Settings"),
            shortcut_in_use: s("{key} is in use · Change"),
            needs_update: s("App needs an update · run turnlane self-install"),
            restart_to_update: restart_to_update_en(),
            quit: s("Quit Turnlane"),
            app: AppText {
                about: s("About Turnlane"),
                settings: s("Settings…"),
                hide: s("Hide Turnlane"),
                hide_others: s("Hide Others"),
                show_all: s("Show All"),
            },
            edit: EditText {
                title: s("Edit"),
                undo: undo_en(),
                redo: redo_en(),
                cut: s("Cut"),
                copy: s("Copy"),
                paste: s("Paste"),
                select_all: s("Select All"),
            },
            view: ViewText { title: s("View"), three: s("3 Days"), week: s("Week"), day: s("Day"), reload: s("Reload") },
            window: WindowText { title: s("Window"), minimize: s("Minimize"), close: s("Close Window") },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_fallback_by_preferred_language() {
        assert_eq!(fallback("ja-JP").quit, "Turnlane を終了");
        assert_eq!(fallback("en-US").quit, "Quit Turnlane");
        assert_eq!(fallback("fr").view.three, "3 Days");
    }

    #[test]
    fn reads_the_daemon_shape() {
        // packages/core/src/desktop/menu-text.ts の NATIVE_MENU.ja と同じ形
        let m: NativeMenu = serde_json::from_str(
            r#"{"open":"Turnlane を開く","quickAdd":"クイック入力","offline":"x","startDaemon":"Turnlane を起動",
                "notificationsOff":"n","shortcutInUse":"{key} は使用中です · 変更","needsUpdate":"u","quit":"Turnlane を終了",
                "app":{"about":"a","settings":"設定…","hide":"h","hideOthers":"ho","showAll":"sa"},
                "edit":{"title":"編集","cut":"c","copy":"cp","paste":"p","selectAll":"s"},
                "view":{"title":"表示","three":"3日","week":"週","day":"デイビュー","reload":"再読み込み"},
                "window":{"title":"ウインドウ","minimize":"しまう","close":"ウインドウを閉じる"}}"#,
        )
        .unwrap();
        assert_eq!(m.quick_add, "クイック入力");
        assert_eq!(m.app.hide_others, "ho");
        assert_eq!(m.view.three, "3日");
        assert_eq!(m.restart_to_update, "Restart to Finish Update");
        // 古いデーモン（取り消す・やり直すの文言が無い）
        assert_eq!(m.edit.undo, "Undo");
        assert_eq!(m.edit.redo, "Redo");
    }

    fn item(action: &str, value: &str) -> UpdateItem {
        UpdateItem { label: "l".into(), action: action.into(), value: value.into(), copied: "Copied".into() }
    }

    #[test]
    fn reads_the_update_item() {
        // packages/core の updateMenuItem と同じ形
        let u: UpdateItem = serde_json::from_str(
            r#"{"label":"Turnlane 0.7.1 is available · Copy brew upgrade --cask turnlane","action":"copy",
                "value":"brew upgrade --cask turnlane","copied":"Copied"}"#,
        )
        .unwrap();
        assert_eq!(u.label, "Turnlane 0.7.1 is available · Copy brew upgrade --cask turnlane");
        assert_eq!(update_action(&u), Some(UpdateAction::Copy("brew upgrade --cask turnlane")));
        let ja: UpdateItem = serde_json::from_str(
            r#"{"label":"Turnlane 0.7.1 に更新できます · リリースのページを開く","action":"open",
                "value":"https://github.com/turnlane/turnlane/releases/latest","copied":"コピーしました"}"#,
        )
        .unwrap();
        assert_eq!(ja.label, "Turnlane 0.7.1 に更新できます · リリースのページを開く");
        assert_eq!(update_action(&ja), Some(UpdateAction::Open("https://github.com/turnlane/turnlane/releases/latest")));
    }

    #[test]
    fn copies_and_opens_only_the_known_shapes() {
        assert_eq!(update_action(&item("copy", "rm -rf ~")), None);
        assert_eq!(update_action(&item("copy", "brew upgrade --cask turnlane\nrm -rf ~")), None);
        assert_eq!(update_action(&item("open", "https://evil.example/")), None);
        assert_eq!(update_action(&item("open", "file:///etc/passwd")), None);
        assert_eq!(update_action(&item("run", "brew upgrade --cask turnlane")), None);
    }

    #[test]
    fn restart_to_finish_update_comes_before_the_update_notice() {
        let u = item("copy", "brew upgrade --cask turnlane");
        assert_eq!(version_note(true, false, Some(&u)), VersionNote::Restart);
        assert_eq!(version_note(true, true, None), VersionNote::Restart);
        assert_eq!(version_note(false, false, Some(&u)), VersionNote::Notes { mismatch: false, update: true });
        assert_eq!(version_note(false, true, Some(&u)), VersionNote::Notes { mismatch: true, update: true });
        assert_eq!(version_note(false, false, None), VersionNote::Notes { mismatch: false, update: false });
        // 確かめられない項目は出さない
        assert_eq!(
            version_note(false, false, Some(&item("open", "http://x"))),
            VersionNote::Notes { mismatch: false, update: false }
        );
    }

    #[test]
    fn reads_undo_and_redo() {
        let m: EditText = serde_json::from_str(
            r#"{"title":"編集","undo":"取り消す","redo":"やり直す","cut":"c","copy":"cp","paste":"p","selectAll":"s"}"#,
        )
        .unwrap();
        assert_eq!((m.undo.as_str(), m.redo.as_str()), ("取り消す", "やり直す"));
        assert_eq!(fallback("ja").edit.undo, "取り消す");
    }
}
