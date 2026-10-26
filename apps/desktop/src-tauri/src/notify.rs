//! ネイティブ通知（desktop-shell.md 3章）。UNUserNotificationCenter を objc2 で直接呼ぶ（M2-S6 の結論）。
//! - 題名・本文・音の有無・クリックで開く画面はデーモンの `notify` イベントのまま出す（Rust で判定しない）
//! - クリック（本体のタップ = UNNotificationDefaultActionIdentifier）だけを扱う。消しただけの操作は届かない
//!   （カテゴリに CustomDismissAction を付けていないため）
//! - 開く画面は targetContentIdentifier に入れる（アプリを再起動した後に残った通知をクリックしても開ける）
//! - 許可の要求・システム設定を開く操作は、設定画面からデーモンの `desktop_notifications` で受ける（D-080）。
//!   開く URL は固定（値を受け取らない）
//! - 即時の通知の path には `open=<followUpId>` が付く。クリックでデーモンにタスクの既定の開き先を開かせ
//!   （`POST /api/open`。D-059）、main は開かない。失敗したら main で path を開く。Rust は ID を渡すだけ
//! - 集中モードの問い（D-097。desktop-shell.md 3.5）は通知上のボタン（`actions`。文言はデーモン）を付けて出す。
//!   押されたボタン（focus / skip）は path の `focus=<key>` と一緒に `POST /api/focus/prompt` へ送る。path は userInfo の
//!   `path` にも入れ（応答では userInfo → targetContentIdentifier の順に読む）、送れなかったら main で path（帯の問い）を開く。
//!   受け取り（SSE）→ OS に出した結果 → 押された応答 → 送った結果の各段を stderr に 1 行ずつ残す（desktop-shell.md 3.5）。
//!   問いが閉じたら（SSE focus の prompt: false。遅れた答えを受ける late: true の間は除く）出した通知を取り下げる
//! - 即時の通知に `promptTitle: true` が付いていたら、出す直前に `GET /api/work-items/<id>/glance` を読み、
//!   `prompt.text`（直近の意味のある指示の 1 行目。デーモンで短い返事を飛ばし、伏せ字と切り詰めを通してある）を題名にする
//!   （D-211）。読めない・無い（設定「行に中身を出す」がオフ）ときはデーモンの題名のまま。読んだ中身は通知にだけ渡し、
//!   覚えない・ログに書かない
//! - まとめの通知に `promptLines`（body の行と同じ順の `{ workItemId, suffix }` か null）が付いていたら、出す直前に各項目の
//!   glance を読み、`prompt.text`（行と同じ件名）があればその行を `<prompt><suffix>` にする（D-214 (1)）。
//!   読めない行はデーモンの行のまま。読んだ中身は通知にだけ渡す

use crate::{daemon, tray, windows, Shared};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
pub struct Payload {
    pub notices: Vec<Notice>,
}

#[derive(Deserialize, Clone)]
pub struct Notice {
    pub id: String,
    pub title: String,
    /// 副題（`待ちの種類 · リポジトリ`。D-207 (4)）。古いデーモンは送らない
    #[serde(default)]
    pub subtitle: String,
    pub body: String,
    pub path: String,
    pub sound: bool,
    /// 通知上のボタン（集中モードの問いだけ）
    #[serde(default)]
    pub actions: Vec<Action>,
    /// 題名を直近の意味のある指示に差し替えてよい（D-211）。出す直前に glance を読む。古いデーモンは送らない
    #[serde(default, rename = "promptTitle")]
    pub prompt_title: bool,
    /// まとめの通知の各行を直近の指示に差し替えてよい（D-214 (1)）。body の行と同じ順。古いデーモンは送らない
    #[serde(default, rename = "promptLines")]
    pub prompt_lines: Vec<Option<PromptLine>>,
}

#[derive(Deserialize, Clone)]
pub struct PromptLine {
    #[serde(rename = "workItemId")]
    pub work_item_id: String,
    #[serde(default)]
    pub suffix: String,
}

#[derive(Deserialize, Clone)]
pub struct Action {
    pub id: String,
    pub title: String,
}

/// 集中モードの問いの通知の識別子とカテゴリ（デーモンの promptMessage と同じ）
pub const FOCUS_PROMPT_ID: &str = "focus-prompt";
const FOCUS_CATEGORY: &str = "focus_prompt";
/// 受け付けるボタン（それ以外は無視する）
const FOCUS_ANSWERS: [&str; 2] = ["focus", "skip"];

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub enum Permission {
    #[default]
    Unknown,
    Granted,
    Denied,
    /// 許可を求めたが、まだ答えていない（D-080: 設定画面に「許可を求める」を出す）
    NotDetermined,
    /// .app でない（tauri dev）。UNUserNotificationCenter はバンドルが無いと使えない
    Unsupported,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::Unknown => "unknown",
            Permission::Granted => "granted",
            Permission::Denied => "denied",
            Permission::NotDetermined => "not_determined",
            Permission::Unsupported => "unsupported",
        }
    }
}

/// システム設定の通知の画面（固定の URL。メニューバーの「Open System Settings」と設定画面のボタン）
pub const NOTIFICATION_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

pub fn open_settings() {
    let _ = tauri_plugin_opener::open_url(NOTIFICATION_SETTINGS_URL, None::<&str>);
}

/// システム設定 › プライバシーとセキュリティ › オートメーション（端末に入力できなかったときの知らせのボタン。D-193 B-5）
pub const AUTOMATION_SETTINGS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

pub fn open_automation_settings() {
    let _ = tauri_plugin_opener::open_url(AUTOMATION_SETTINGS_URL, None::<&str>);
}

/// デーモンの `desktop_notifications`（設定画面のボタン。D-080）。知らない action は無視する
pub fn on_action(app: &AppHandle, action: &str) {
    match action {
        "request" => request(app),
        "open_settings" => open_settings(),
        "open_automation_settings" => open_automation_settings(),
        _ => {}
    }
}

fn set_permission(app: &AppHandle, p: Permission) {
    app.state::<Shared>().st.lock().unwrap().notifications = p;
    tray::refresh(app);
    report_status(app);
}

/// 通知の許可・ホットキーの登録をデーモンに知らせる（`turnlane desktop status` が読む）
pub fn report_status(app: &AppHandle) {
    let (body, online) = {
        let s = app.state::<Shared>();
        let st = s.st.lock().unwrap();
        (
            json!({
                "version": app.package_info().version.to_string(),
                "notifications": st.notifications.as_str(),
                "shortcut": { "accelerator": st.shortcut.accelerator, "registered": st.shortcut.registered },
                // 配布版の常駐の登録（SMAppService。turnlane doctor が読む。M6-14）
                "background": crate::setup::statuses(),
            }),
            st.online,
        )
    };
    if online {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = daemon::call(&app, "POST", "/api/desktop/status", Some(&body));
        });
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
        UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
        UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSSet};
    use std::ptr::NonNull;
    use std::sync::OnceLock;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "TurnlaneNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// アプリが前面にあるときもバナーを出す
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _n: &UNNotification,
                handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let action = response.actionIdentifier().to_string();
                let request = response.notification().request();
                let content = request.content();
                let target = content.targetContentIdentifier().map(|s| s.to_string());
                let (path, from) = super::pick_path(user_info_path(&content), target);
                let default_action = action == unsafe { UNNotificationDefaultActionIdentifier }.to_string();
                // 押されたことを最初に残す（この行が無ければ OS からアプリに届いていない）。題名・本文は書かない
                windows::log(&format!(
                    "notification response: id={} action={} path={from}",
                    super::log_id(&request.identifier().to_string()),
                    if default_action { "default".to_string() } else { super::log_id(&action) },
                ));
                // 本体のクリックと、集中モードの問いのボタンだけ（消しただけの操作は扱わない。3.3・3.5）
                let route = super::route_response(&action, default_action, path.as_deref());
                match APP.get() {
                    Some(app) => super::on_response(app, route, path),
                    None => windows::log("notification response ignored: app not ready"),
                }
                handler.call(());
            }
        }
    );

    /// userInfo の `path`（出すときに入れたもの。古いアプリが出した通知には無い）
    fn user_info_path(content: &objc2_user_notifications::UNNotificationContent) -> Option<String> {
        let v = content.userInfo().objectForKey(&NSString::from_str(super::USER_INFO_PATH))?;
        v.downcast::<NSString>().ok().map(|s| s.to_string())
    }

    fn bundled() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
            && NSBundle::mainBundle().bundlePath().to_string().ends_with(".app")
    }

    pub fn init(app: &AppHandle) {
        if !bundled() {
            set_permission(app, Permission::Unsupported);
            return;
        }
        let _ = APP.set(app.clone());
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // delegate は弱参照なので、アプリが終わるまで解放しない
        std::mem::forget(delegate);
        request(app);
    }

    /// 許可を求める（初回起動と、設定画面の「許可を求める」。未決定なら OS がダイアログを出す）
    pub fn request(app: &AppHandle) {
        if !bundled() {
            return;
        }
        let a = app.clone();
        let done = RcBlock::new(move |granted: Bool, e: *mut NSError| {
            if let Some(e) = unsafe { e.as_ref() } {
                windows::trace(&format!("notification authorization error: {} {}", e.domain(), e.code()));
            }
            windows::trace(&format!("notification authorization granted={}", granted.as_bool()));
            // 実際の状態（未決定のまま・拒否）を読み直して出す
            refresh_permission(&a);
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &done,
        );
    }

    /// 設定アプリで許可を変えたときのために、メニューを開く前などに読み直す
    pub fn refresh_permission(app: &AppHandle) {
        if !bundled() {
            return;
        }
        let a = app.clone();
        let done = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
            let status = unsafe { s.as_ref() }.authorizationStatus();
            let p = match status {
                UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => Permission::Granted,
                UNAuthorizationStatus::Denied => Permission::Denied,
                UNAuthorizationStatus::NotDetermined => Permission::NotDetermined,
                _ => Permission::Unknown,
            };
            windows::trace(&format!("notification authorization status={}", status.0));
            if app_permission(&a) != p {
                set_permission(&a, p);
            }
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&done);
    }

    fn app_permission(app: &AppHandle) -> Permission {
        app.state::<Shared>().st.lock().unwrap().notifications
    }

    pub fn show(n: &Notice) {
        if !bundled() {
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&n.title));
        if !n.subtitle.is_empty() {
            content.setSubtitle(&NSString::from_str(&n.subtitle));
        }
        content.setBody(&NSString::from_str(&n.body));
        content.setTargetContentIdentifier(Some(&NSString::from_str(&n.path)));
        // 応答で path を確実に読めるように userInfo にも入れる（値は文字列だけ）
        let info = NSDictionary::from_slices(&[&*NSString::from_str(super::USER_INFO_PATH)], &[&*NSString::from_str(&n.path)]);
        // SAFETY: NSDictionary<NSString, NSString> は NSDictionary<AnyObject, AnyObject> として扱える
        unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        if !n.actions.is_empty() {
            // ボタンの文言は通知ごとにデーモンから来るので、出す前にカテゴリを登録し直す（3.5）
            let actions: Vec<_> = n
                .actions
                .iter()
                .filter(|a| FOCUS_ANSWERS.contains(&a.id.as_str()))
                .map(|a| {
                    UNNotificationAction::actionWithIdentifier_title_options(
                        &NSString::from_str(&a.id),
                        &NSString::from_str(&a.title),
                        UNNotificationActionOptions::empty(),
                    )
                })
                .collect();
            let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(FOCUS_CATEGORY),
                &NSArray::from_retained_slice(&actions),
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            );
            UNUserNotificationCenter::currentNotificationCenter()
                .setNotificationCategories(&NSSet::from_retained_slice(&[category]));
            content.setCategoryIdentifier(&NSString::from_str(FOCUS_CATEGORY));
        }
        if n.sound {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        // 同じ id は OS 側で置き換わる（まとめ通知 `turn` は1つだけ残る）
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&n.id),
            &content,
            None,
        );
        let id = super::log_id(&n.id);
        let actions = n.actions.len();
        let done = RcBlock::new(move |e: *mut NSError| match unsafe { e.as_ref() } {
            Some(e) => windows::log(&format!("notification post failed: id={id} error={} {}", e.domain(), e.code())),
            // ボタン付き（集中モードの問い）だけ残す（ほかの通知は数が多い）
            None if actions > 0 => {
                windows::log(&format!("notification posted: id={id} category={FOCUS_CATEGORY} actions={actions}"))
            }
            None => {}
        });
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&req, Some(&done));
    }

    /// 出した集中モードの問いを取り下げる（帯で答えた・開始の時刻を過ぎた）
    pub fn remove_prompt() {
        if !bundled() {
            return;
        }
        let ids = NSArray::from_retained_slice(&[NSString::from_str(FOCUS_PROMPT_ID)]);
        let c = UNUserNotificationCenter::currentNotificationCenter();
        c.removeDeliveredNotificationsWithIdentifiers(&ids);
        c.removePendingNotificationRequestsWithIdentifiers(&ids);
    }
}

#[cfg(target_os = "macos")]
pub use mac::{init, refresh_permission, remove_prompt, request};

#[cfg(not(target_os = "macos"))]
pub fn remove_prompt() {}

/// path のクエリの `focus=<key>`（英数字・`-`・`_`・`:` だけ、64文字以内。それ以外は無視する）
pub fn focus_key(path: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    let v = q.split('&').find_map(|kv| kv.strip_prefix("focus="))?;
    // デーモンは encodeURIComponent で `:` を %3A にする
    let v = v.replace("%3A", ":").replace("%3a", ":");
    let ok = !v.is_empty()
        && v.len() <= 64
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':');
    ok.then_some(v)
}

/// 通知の userInfo で path を入れるキー
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const USER_INFO_PATH: &str = "path";

/// 応答の path: userInfo の `path` → targetContentIdentifier の順（どちらから読んだかをログに書く）
pub fn pick_path(user_info: Option<String>, target: Option<String>) -> (Option<String>, &'static str) {
    let ok = |p: &Option<String>| p.as_deref().is_some_and(|s| !s.is_empty());
    if ok(&user_info) {
        (user_info, "user_info")
    } else if ok(&target) {
        (target, "target")
    } else {
        (None, "none")
    }
}

/// ログに書く識別子（英数字と `-_:.` だけ、64 文字まで。ほかの文字は `?`）
pub fn log_id(s: &str) -> String {
    s.chars().take(64).map(|c| if c.is_ascii_alphanumeric() || "-_:.".contains(c) { c } else { '?' }).collect()
}

/// 通知の応答の行き先（Rust は判定しない: main で開くか、デーモンへ答えを渡すか）
#[derive(Debug, PartialEq)]
pub enum Route {
    /// 本体のクリック: path を開く（path が無ければ /queue）
    Open(String),
    /// 集中モードの問いのボタン: `POST /api/focus/prompt` に `{ key, answer }`
    Answer { key: String, answer: String },
    /// 扱わない（理由をログに書く）
    Ignore(&'static str),
}

pub fn route_response(action: &str, default_action: bool, path: Option<&str>) -> Route {
    if default_action {
        return Route::Open(path.filter(|p| !p.is_empty()).unwrap_or("/queue").to_string());
    }
    if !FOCUS_ANSWERS.contains(&action) {
        return Route::Ignore("unknown action");
    }
    let Some(path) = path else { return Route::Ignore("no path") };
    let Some(key) = focus_key(path) else { return Route::Ignore("no key in path") };
    Route::Answer { key, answer: action.to_string() }
}

/// 答えの要求の本文
pub fn answer_body(key: &str, answer: &str) -> Value {
    json!({ "key": key, "answer": answer })
}

/// 応答を処理する。集中モードの問いのボタンは答えを送り、結果を stderr に残す。送れなかったら（デーモンが断った・
/// つながらない）main で path を開き、帯の問いで答えられるようにする
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_response(app: &AppHandle, route: Route, path: Option<String>) {
    match route {
        Route::Open(p) => on_click(app, p),
        Route::Ignore(why) => windows::log(&format!("notification response ignored: {why}")),
        Route::Answer { key, answer } => {
            let app = app.clone();
            std::thread::spawn(move || {
                windows::log(&format!("focus prompt answer {answer} sending"));
                match daemon::call(&app, "POST", "/api/focus/prompt", Some(&answer_body(&key, &answer))) {
                    Ok(_) => windows::log(&format!("focus prompt answer {answer} accepted")),
                    Err(e) => {
                        windows::log(&format!("focus prompt answer {answer} failed: {e}; opening the board"));
                        windows::open_main(&app, path);
                    }
                }
            });
        }
    }
}

/// path のクエリの `open=<followUpId>`（英数字・`-`・`_` だけ。それ以外は無視して main で開く）
pub fn open_target(path: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    let v = q.split('&').find_map(|kv| kv.strip_prefix("open="))?;
    let ok = !v.is_empty() && v.len() <= 64 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then(|| v.to_string())
}

/// 通知のクリック: タスクの既定の開き先（デーモン）→ 失敗したら main で path
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_click(app: &AppHandle, path: String) {
    let Some(id) = open_target(&path) else {
        windows::open_main(app, Some(path));
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        if daemon::call(&app, "POST", "/api/open", Some(&json!({ "followUpId": id }))).is_err() {
            windows::open_main(&app, Some(path));
        }
    });
}

/// 即時の通知の `wi:<workItemId>` の id（英数字・`-`・`_` だけ、64文字以内。それ以外は読まない）
pub fn work_item_of(id: &str) -> Option<&str> {
    let v = id.strip_prefix("wi:")?;
    let ok = !v.is_empty() && v.len() <= 64 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    ok.then_some(v)
}

/// 件名に使う指示の長さの上限（デーモンの PROMPT_SUBJECT_MAX と同じ 120 文字。念のためここでも切る）
const PROMPT_TITLE_MAX: usize = 120;

/// glance の応答から通知の題名を決める（`prompt.text` があればそれ、無ければ fallback）
pub fn title_from_glance(fallback: &str, glance: Option<&Value>) -> String {
    let p = glance
        .and_then(|g| g.get("prompt"))
        .and_then(|p| p.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty());
    match p {
        Some(t) if t.chars().count() > PROMPT_TITLE_MAX => {
            let mut s: String = t.chars().take(PROMPT_TITLE_MAX - 1).collect();
            s.push('…');
            s
        }
        Some(t) => t.to_string(),
        None => fallback.to_string(),
    }
}

/// まとめの通知の本文: promptLines の行は glance の prompt（読めなければ元の行）に差し替える
pub fn body_from_glances(body: &str, lines: &[Option<PromptLine>], read: impl Fn(&str) -> Option<Value>) -> String {
    body.split('\n')
        .enumerate()
        .map(|(i, line)| {
            let Some(Some(p)) = lines.get(i) else { return line.to_string() };
            let Some(id) = work_item_of(&format!("wi:{}", p.work_item_id)).map(str::to_string) else {
                return line.to_string();
            };
            let g = read(&id);
            let t = title_from_glance("", g.as_ref());
            if t.is_empty() {
                line.to_string()
            } else {
                format!("{t}{}", p.suffix)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 通知を出す。promptTitle の付いた即時の通知・promptLines の付いたまとめの通知は、別のスレッドで glance を読んでから出す
/// （SSE の読み取りを止めない）
pub fn post(app: &AppHandle, n: Notice) {
    if !n.actions.is_empty() {
        // 問いを受け取った（この行が無ければデーモンから届いていない）。通知の許可も書く（許可が無いと OS に出せない）
        let ids: Vec<_> = n.actions.iter().map(|a| log_id(&a.id)).collect();
        let permission = app.state::<Shared>().st.lock().unwrap().notifications.as_str();
        windows::log(&format!(
            "notification received: id={} actions={} permission={permission}",
            log_id(&n.id),
            ids.join(",")
        ));
    }
    if !n.prompt_lines.is_empty() {
        let app = app.clone();
        std::thread::spawn(move || {
            let body = body_from_glances(&n.body, &n.prompt_lines, |id| {
                daemon::call(&app, "GET", &format!("/api/work-items/{id}/glance"), None).ok()
            });
            show(&app, &Notice { body, ..n });
        });
        return;
    }
    let Some(id) = n.prompt_title.then(|| work_item_of(&n.id)).flatten().map(str::to_string) else {
        show(app, &n);
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let g = daemon::call(&app, "GET", &format!("/api/work-items/{id}/glance"), None).ok();
        let title = title_from_glance(&n.title, g.as_ref());
        show(&app, &Notice { title, ..n });
    });
}

pub fn show(_app: &AppHandle, n: &Notice) {
    #[cfg(target_os = "macos")]
    mac::show(n);
    #[cfg(not(target_os = "macos"))]
    let _ = n;
}

#[cfg(not(target_os = "macos"))]
pub fn init(app: &AppHandle) {
    set_permission(app, Permission::Unsupported);
}

#[cfg(not(target_os = "macos"))]
pub fn refresh_permission(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn request(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::{
        answer_body, body_from_glances, focus_key, log_id, open_target, pick_path, route_response, title_from_glance,
        work_item_of, Notice, Permission, Route,
    };
    use serde_json::json;

    #[test]
    fn title_follows_the_latest_prompt_from_glance() {
        let fallback = "Fix login";
        let g = json!({ "workItemId": "a", "kind": "none", "prompt": { "text": "  通知の件名を直す " }, "readAt": 0 });
        assert_eq!(title_from_glance(fallback, Some(&g)), "通知の件名を直す");
        // 設定「行に中身を出す」がオフ（unavailable: off）・指示が無い・読めないときはデーモンの題名
        let off = json!({ "workItemId": "a", "kind": "none", "unavailable": "off", "readAt": 0 });
        assert_eq!(title_from_glance(fallback, Some(&off)), fallback);
        assert_eq!(title_from_glance(fallback, Some(&json!({ "prompt": { "text": "" } }))), fallback);
        assert_eq!(title_from_glance(fallback, None), fallback);
        let long = "あ".repeat(200);
        let t = title_from_glance(fallback, Some(&json!({ "prompt": { "text": long } })));
        assert_eq!(t.chars().count(), 120);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn reads_prompt_title_flag_and_work_item_id() {
        let n: Notice = serde_json::from_str(
            r#"{"id":"wi:0192-a_b","title":"t","body":"","path":"/queue","sound":true,"promptTitle":true}"#,
        )
        .unwrap();
        assert!(n.prompt_title);
        assert_eq!(work_item_of(&n.id), Some("0192-a_b"));
        let old: Notice = serde_json::from_str(r#"{"id":"turn","title":"t","body":"b","path":"/queue","sound":false}"#).unwrap();
        assert!(!old.prompt_title);
        assert_eq!(work_item_of("turn"), None);
        assert_eq!(work_item_of("wi:../x"), None);
        assert_eq!(work_item_of("wi:"), None);
    }

    #[test]
    fn batch_lines_follow_the_pinned_prompt_from_glance() {
        let n: Notice = serde_json::from_str(
            r#"{"id":"turn","title":"t","body":"Board widths — Needs reply\nnamed — Needs review\nTZ test — Needs reply","path":"/queue","sound":false,
               "promptLines":[{"workItemId":"a","suffix":" — Needs reply"},null,{"workItemId":"c","suffix":" — Needs reply"}]}"#,
        )
        .unwrap();
        let body = body_from_glances(&n.body, &n.prompt_lines, |id| match id {
            "a" => Some(json!({ "prompt": { "text": "3日ボードの列幅を直して" } })),
            _ => Some(json!({ "unavailable": "off" })),
        });
        assert_eq!(body, "3日ボードの列幅を直して — Needs reply\nnamed — Needs review\nTZ test — Needs reply");
        let old: Notice = serde_json::from_str(r#"{"id":"turn","title":"t","body":"b","path":"/queue","sound":false}"#).unwrap();
        assert!(old.prompt_lines.is_empty());
    }

    #[test]
    fn reads_subtitle_when_present() {
        let n: Notice = serde_json::from_str(
            r#"{"id":"wi:a","title":"t","subtitle":"Needs approval · web-app","body":"","path":"/queue","sound":true}"#,
        )
        .unwrap();
        assert_eq!(n.subtitle, "Needs approval · web-app");
        let old: Notice =
            serde_json::from_str(r#"{"id":"turn","title":"t","body":"b","path":"/queue","sound":false}"#).unwrap();
        assert_eq!(old.subtitle, "");
    }

    #[test]
    fn reads_focus_key_from_path() {
        assert_eq!(
            focus_key("/board?focus=0192aa-1b%3A1789372800000").as_deref(),
            Some("0192aa-1b:1789372800000")
        );
        assert_eq!(focus_key("/board?x=1&focus=a:1").as_deref(), Some("a:1"));
        assert_eq!(focus_key("/board"), None);
        assert_eq!(focus_key("/board?focus="), None);
        assert_eq!(focus_key("/board?focus=../x"), None);
        assert_eq!(focus_key(&format!("/board?focus={}", "a".repeat(65))), None);
    }

    #[test]
    fn routes_the_focus_prompt_buttons_to_the_daemon() {
        let path = "/board?focus=0192aa-1b%3A1789372800000";
        let key = "0192aa-1b:1789372800000";
        // 「集中する」「しない」: key と答えを送る
        assert_eq!(route_response("focus", false, Some(path)), Route::Answer { key: key.into(), answer: "focus".into() });
        assert_eq!(route_response("skip", false, Some(path)), Route::Answer { key: key.into(), answer: "skip".into() });
        assert_eq!(answer_body(key, "focus"), json!({ "key": key, "answer": "focus" }));
        // 本体のクリック: path（無ければ /queue）を開く
        assert_eq!(route_response("default", true, Some(path)), Route::Open(path.into()));
        assert_eq!(route_response("default", true, None), Route::Open("/queue".into()));
        assert_eq!(route_response("default", true, Some("")), Route::Open("/queue".into()));
        // 知らないボタン・path が無い・key が無い: 送らない（理由はログ）
        let dismiss = "com.apple.UNNotificationDismissActionIdentifier";
        assert_eq!(route_response(dismiss, false, Some(path)), Route::Ignore("unknown action"));
        assert_eq!(route_response("focus", false, None), Route::Ignore("no path"));
        assert_eq!(route_response("focus", false, Some("/board")), Route::Ignore("no key in path"));
    }

    #[test]
    fn reads_the_path_from_user_info_first() {
        let p = |s: &str| Some(s.to_string());
        assert_eq!(pick_path(p("/board?focus=a:1"), p("/x")), (p("/board?focus=a:1"), "user_info"));
        // userInfo が無い（古いアプリが出した通知）・空なら targetContentIdentifier
        assert_eq!(pick_path(None, p("/board?focus=a:1")), (p("/board?focus=a:1"), "target"));
        assert_eq!(pick_path(p(""), p("/x")), (p("/x"), "target"));
        assert_eq!(pick_path(None, None), (None, "none"));
        assert_eq!(pick_path(None, p("")), (None, "none"));
    }

    #[test]
    fn log_ids_keep_only_safe_characters() {
        assert_eq!(log_id("wi:0192-a_b"), "wi:0192-a_b");
        assert_eq!(log_id("focus-prompt"), "focus-prompt");
        assert_eq!(log_id("a b/c\n"), "a?b?c?");
        assert_eq!(log_id(&"a".repeat(100)).len(), 64);
    }

    #[test]
    fn reads_open_target_from_path() {
        assert_eq!(open_target("/queue?item=a&open=f-1_2").as_deref(), Some("f-1_2"));
        assert_eq!(open_target("/queue?open=0192aa"), Some("0192aa".into()));
        assert_eq!(open_target("/queue?item=a"), None);
        assert_eq!(open_target("/queue"), None);
        assert_eq!(open_target("/queue?open="), None);
        assert_eq!(open_target("/queue?open=../etc"), None);
        assert_eq!(open_target("/queue?open=a%20b"), None);
    }

    #[test]
    fn permission_names_match_the_daemon() {
        // apps/daemon/src/http/desktop-routes.ts の NOTIFICATION_PERMISSIONS と同じ名前（D-080）
        let all = [
            Permission::Unknown,
            Permission::Granted,
            Permission::Denied,
            Permission::NotDetermined,
            Permission::Unsupported,
        ];
        let names: Vec<_> = all.iter().map(|p| p.as_str()).collect();
        assert_eq!(names, ["unknown", "granted", "denied", "not_determined", "unsupported"]);
    }
}
