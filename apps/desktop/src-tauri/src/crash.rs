//! 落ちたときの手がかり（release は `panic = "abort"` で、クラッシュレポートには記号が無い）。
//! - Rust の panic: 理由・場所・スレッドを `~/Library/Logs/turnlane/desktop-panic.log` に書いてから終わる（abort は変えない）
//! - Objective-C の捕まらなかった例外: 名前・理由・呼び出しの記号を同じファイルに書く（その後 AppKit が abort する）
//! - どちらも直近の記録（windows::recent_log）を添える。会話の中身は記録に入らない（記録は接続・起動の出来事だけ）
//! - アプリが終わる途中（EXITING）は、ウインドウを作り直さない（Reopen・単一インスタンス・open_main。windows.rs）

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

/// 終わり始めた（app.exit・⌘Q・更新の後の開き直し・RunEvent::Exit）。立ったらウインドウを作らない
static EXITING: AtomicBool = AtomicBool::new(false);

pub fn set_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

pub fn exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

/// 書く場所（HOME が無ければ書かない）
pub fn log_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join("Library/Logs/turnlane/desktop-panic.log"))
}

/// これより大きくなったら最初から書き直す（毎回の起動で育ち続けない）
const MAX_BYTES: u64 = 256 * 1024;

/// UNIX 秒 → `2026-10-29T14:46:03Z`（純粋関数。テストする）
pub fn utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // 1970-01-01 からの日数 → 年月日（Howard Hinnant の civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

/// 1 件の記録（純粋関数。テストする）
pub fn entry(kind: &str, when: &str, version: &str, thread: &str, lines: &[String], recent: &[String]) -> String {
    let mut s = format!("=== {when} turnlane {version} {kind} (thread {thread}, exiting {})\n", exiting());
    for l in lines {
        s.push_str(l);
        s.push('\n');
    }
    if !recent.is_empty() {
        s.push_str("--- recent\n");
        for l in recent {
            s.push_str(l);
            s.push('\n');
        }
    }
    s
}

fn append(text: &str) {
    let Some(path) = log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fresh = std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false);
    let f = std::fs::OpenOptions::new().create(true).append(!fresh).write(true).truncate(fresh).open(&path);
    if let Ok(mut f) = f {
        let _ = f.write_all(text.as_bytes());
        let _ = f.flush();
    }
}

fn now_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    utc(secs)
}

fn thread_name() -> String {
    let t = std::thread::current();
    t.name().map(str::to_string).unwrap_or_else(|| format!("{:?}", t.id()))
}

/// panic の記録と、Objective-C の例外の記録を始める（main の最初で呼ぶ）
pub fn install(version: &'static str) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(non-string panic payload)".into());
        let at = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let mut lines = vec![format!("panic: {msg}"), format!("at: {at}")];
        lines.extend(bt.lines().take(60).map(str::to_string));
        append(&entry("panic", &now_utc(), version, &thread_name(), &lines, &crate::windows::recent_log()));
        default(info);
    }));
    #[cfg(target_os = "macos")]
    objc_exceptions::install(version);
}

#[cfg(target_os = "macos")]
mod objc_exceptions {
    use objc2_foundation::{NSException, NSSetUncaughtExceptionHandler, NSUncaughtExceptionHandler};
    use std::sync::OnceLock;

    static VERSION: OnceLock<&'static str> = OnceLock::new();

    extern "C" fn on_exception(e: *mut NSException) {
        // ここでは panic しない（abort の前に書けることだけをする）
        let Some(e) = (unsafe { e.as_ref() }) else { return };
        let mut lines = vec![
            format!("objc exception: {}", e.name()),
            format!("reason: {}", e.reason().map(|r| r.to_string()).unwrap_or_default()),
        ];
        let syms = e.callStackSymbols();
        for i in 0..syms.count().min(60) {
            lines.push(syms.objectAtIndex(i).to_string());
        }
        let v = VERSION.get().copied().unwrap_or("?");
        super::append(&super::entry(
            "objc_exception",
            &super::now_utc(),
            v,
            &super::thread_name(),
            &lines,
            &crate::windows::recent_log(),
        ));
    }

    pub fn install(version: &'static str) {
        let _ = VERSION.set(version);
        unsafe { NSSetUncaughtExceptionHandler(on_exception as *mut NSUncaughtExceptionHandler) };
    }
}

#[cfg(test)]
mod tests {
    use super::{entry, utc};

    #[test]
    fn formats_utc() {
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
        // 2026-10-29T14:46:03Z
        assert_eq!(utc(1_793_285_163), "2026-10-29T14:46:03Z");
        assert_eq!(utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn entry_has_header_lines_and_recent_log() {
        let e = entry("panic", "2026-10-29T14:46:03Z", "0.7.3", "main", &["panic: x".into(), "at: a.rs:1:2".into()], &["+0.1s daemon: connected".into()]);
        assert!(e.starts_with("=== 2026-10-29T14:46:03Z turnlane 0.7.3 panic (thread main, exiting "));
        assert!(e.contains("\npanic: x\nat: a.rs:1:2\n--- recent\n+0.1s daemon: connected\n"));
        let bare = entry("objc_exception", "t", "v", "1", &["objc exception: N".into()], &[]);
        assert!(!bare.contains("--- recent"));
    }
}
