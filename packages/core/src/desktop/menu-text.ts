/**
 * デスクトップアプリのネイティブのメニュー（メニューバーの右クリックとアプリのメニュー）の文言（desktop-shell.md 2.5・4.2）。
 * 集中モードのサブメニュー（FOCUS_MENU）と同じく、ロケールはデーモンで解決して /api/queue/summary の nativeMenu で返す。
 * 英語は macOS の慣習どおり Title Case（sentence case の規則の例外）。{key} はクイック入力のキーの表記に置き換える
 */
import { type UpdateDownload, updatePhase } from "../update-download.ts";
export interface NativeMenuText {
  // メニューバーの右クリック
  open: string;
  quickAdd: string;
  offline: string;
  startDaemon: string;
  notificationsOff: string;
  shortcutInUse: string;
  needsUpdate: string;
  /** アプリが動いている間にバンドルが入れ替わった（更新の後）。押すとアプリを開き直す（onboarding.md 2.5、M6-17） */
  restartToUpdate: string;
  quit: string;
  // アプリのメニュー
  app: { about: string; settings: string; hide: string; hideOthers: string; showAll: string };
  edit: {
    title: string;
    undo: string;
    redo: string;
    cut: string;
    copy: string;
    paste: string;
    selectAll: string;
  };
  view: { title: string; three: string; week: string; day: string; reload: string };
  window: { title: string; minimize: string; close: string };
}

export const NATIVE_MENU: { en: NativeMenuText; ja: NativeMenuText } = {
  en: {
    open: "Open Turnlane",
    quickAdd: "Quick Add",
    offline: "Turnlane isn't running in the background",
    startDaemon: "Start Turnlane",
    notificationsOff: "Notifications are off · Open System Settings",
    shortcutInUse: "{key} is in use · Change",
    needsUpdate: "App needs an update · run turnlane self-install",
    restartToUpdate: "Restart to Finish Update",
    quit: "Quit Turnlane",
    app: {
      about: "About Turnlane",
      settings: "Settings…",
      hide: "Hide Turnlane",
      hideOthers: "Hide Others",
      showAll: "Show All",
    },
    edit: {
      title: "Edit",
      undo: "Undo",
      redo: "Redo",
      cut: "Cut",
      copy: "Copy",
      paste: "Paste",
      selectAll: "Select All",
    },
    view: { title: "View", three: "3 Days", week: "Week", day: "Day", reload: "Reload" },
    window: { title: "Window", minimize: "Minimize", close: "Close Window" },
  },
  ja: {
    open: "Turnlane を開く",
    quickAdd: "クイック入力",
    offline: "Turnlane がバックグラウンドで動いていません",
    startDaemon: "Turnlane を起動",
    notificationsOff: "通知がオフです · システム設定を開く",
    shortcutInUse: "{key} は使用中です · 変更",
    needsUpdate: "アプリの更新が必要です · turnlane self-install を実行",
    restartToUpdate: "再起動して更新を終える",
    quit: "Turnlane を終了",
    app: {
      about: "Turnlane について",
      settings: "設定…",
      hide: "Turnlane を隠す",
      hideOthers: "ほかを隠す",
      showAll: "すべてを表示",
    },
    edit: {
      title: "編集",
      undo: "取り消す",
      redo: "やり直す",
      cut: "カット",
      copy: "コピー",
      paste: "ペースト",
      selectAll: "すべてを選択",
    },
    view: { title: "表示", three: "3日", week: "週", day: "デイビュー", reload: "再読み込み" },
    window: { title: "ウインドウ", minimize: "しまう", close: "ウインドウを閉じる" },
  },
};

/**
 * メニューバーの更新の知らせ（onboarding.md 2.5 の更新確認の行、M6-17。自動更新は ADR 0008 の追記 4）。/api/queue/summary の
 * update で返す。段階（updatePhase）で分ける:
 * - 手動（update.download がオフ・自動の対象外・検証に落ちた）: homebrew は押すと `brew upgrade --cask turnlane` をクリップボードに
 *   写し（copied を短く出す）、download は最新リリースのページを開く
 * - 取得・検証の途中・入れている間: 押せない 1 項目（none）
 * - 入れる用意ができた: `Turnlane 0.7.2 is ready · Restart to update`。押すと POST /api/update/install（install）
 * dev・新しい版が無いときは null（メニューに出さない）。Restart to Finish Update があればアプリがそちらを出す
 */
export interface UpdateMenuItem {
  label: string;
  action: "copy" | "open" | "install" | "none";
  /** copy なら写すコマンド、open なら開く URL（install・none は空） */
  value: string;
  /** 写した直後にメニューバーに短く出す文言 */
  copied: string;
}

const UPDATE_MENU = {
  en: {
    copy: "Turnlane {version} is available · Copy {command}",
    open: "Turnlane {version} is available · Open Releases",
    downloading: "Turnlane {version} is available · Downloading…",
    ready: "Turnlane {version} is ready · Restart to update",
    installing: "Turnlane {version} is ready · Restarting…",
    copied: "Copied",
  },
  ja: {
    copy: "Turnlane {version} に更新できます · {command} をコピー",
    open: "Turnlane {version} に更新できます · リリースのページを開く",
    downloading: "Turnlane {version} に更新できます · ダウンロード中…",
    ready: "Turnlane {version} の準備ができました · 再起動して更新",
    installing: "Turnlane {version} の準備ができました · 再起動しています…",
    copied: "コピーしました",
  },
} as const;

export function updateMenuItem(
  s: {
    available: boolean;
    latest: { version: string } | null;
    channel?: "homebrew" | "download" | "dev";
    upgradeCommand?: string | null;
    releasesUrl?: string | null;
    downloadEnabled?: boolean;
    download?: UpdateDownload | null;
  },
  locale: "en" | "ja",
): UpdateMenuItem | null {
  const phase = updatePhase(s);
  if (!phase) return null;
  const t = UPDATE_MENU[locale];
  const version = phase.version;
  const item = (label: string, action: "install" | "none"): UpdateMenuItem => ({
    label: label.replace("{version}", version),
    action,
    value: "",
    copied: t.copied,
  });
  if (phase.kind === "downloading") return item(t.downloading, "none");
  if (phase.kind === "ready") return item(t.ready, "install");
  if (phase.kind === "installing") return item(t.installing, "none");
  // 手動の案内（失敗したときも退路として同じ）
  if (s.channel === "homebrew" && s.upgradeCommand)
    return {
      label: t.copy.replace("{version}", version).replace("{command}", s.upgradeCommand),
      action: "copy",
      value: s.upgradeCommand,
      copied: t.copied,
    };
  if (s.channel === "download" && s.releasesUrl)
    return {
      label: t.open.replace("{version}", version),
      action: "open",
      value: s.releasesUrl,
      copied: t.copied,
    };
  return null;
}
