fn main() {
    // web から呼べるコマンド。リモート URL に開くのは desktop_hide / desktop_open / desktop_quick_add / desktop_setup だけ（desktop-shell.md 7章）。
    // boot_* は同梱の boot ページ（tauri://localhost）だけに許す（capabilities/boot.json）
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_hide",
            "desktop_open",
            "desktop_quick_add",
            "desktop_setup",
            "boot_state",
            "boot_start_daemon",
            "boot_retry",
            "boot_open_login_items",
            "boot_diagnostics",
            "boot_move_to_applications",
            "boot_report",
        ]),
    ))
    .expect("failed to run tauri-build");
}
