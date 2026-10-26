/**
 * デスクトップアプリ（Turnlane.app。Tauri 2 の WKWebView）の中で動いているときの小さなラッパ（desktop-shell.md 2.5）。
 * `@tauri-apps/api` は入れない。アプリがリモート URL に開くのは desktop_hide / desktop_open / desktop_quick_add だけ。
 * ブラウザでは何もしない。
 */
interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function internals(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null
  );
}

/** アプリの中にいるか（UA の末尾の TurnlaneDesktop/<version> か、Tauri の IPC） */
export function inDesktop(): boolean {
  return (
    internals() !== null ||
    (typeof navigator !== "undefined" && navigator.userAgent.includes("TurnlaneDesktop/"))
  );
}

/** 呼んだウインドウ（ポップオーバー・クイック入力）を隠す。クイック入力なら直前のアプリへフォーカスを返す */
export function desktopHide(): void {
  void internals()
    ?.invoke("desktop_hide")
    .catch(() => {});
}

/** main ウインドウを出して path の画面へ移る。アプリの外（ブラウザ）では同じタブで移る */
export function desktopOpen(path: string): void {
  const t = internals();
  if (t) void t.invoke("desktop_open", { path }).catch(() => {});
  else window.location.assign(path);
}

/**
 * クイック入力（⌥⇧Space と同じ）を開く（メニューバーの「タスクを追加」。D-113）。古いアプリ（コマンドが無い）とブラウザでは
 * Inbox を開く
 */
export function desktopQuickAdd(): void {
  const t = internals();
  if (t) void t.invoke("desktop_quick_add").catch(() => desktopOpen("/inbox"));
  else window.location.assign("/inbox");
}

/** 配布版のアプリの登録の状態（IPC desktop_setup。onboarding.md 5.5） */
export interface DesktopSetupStatus {
  managed: boolean;
  daemon: string;
  calendarHelper: string;
  mainApp: string;
  /** chooseFolder の結果（選ばなければ null） */
  path?: string | null;
}

export type DesktopSetupAction =
  | { action: "status" }
  | { action: "registerCalendarHelper" }
  | { action: "unregisterCalendarHelper" }
  | { action: "setOpenAtLogin"; on: boolean }
  | { action: "openSettings"; pane: "loginItems" | "calendars" | "notifications" | "automation" }
  | { action: "chooseFolder"; prompt: string };

/**
 * アプリの登録・フォルダの選択（M6-14・M6-15）。アプリの外（ブラウザ）・コマンドの無い古いアプリでは null
 * （呼び出し側は今までの経路に落とす）。失敗はエラーのコード（unmanaged など）で投げる
 */
export async function desktopSetup(a: DesktopSetupAction): Promise<DesktopSetupStatus | null> {
  const t = internals();
  if (!t) return null;
  try {
    return (await t.invoke("desktop_setup", { ...a })) as DesktopSetupStatus;
  } catch (e) {
    const msg = typeof e === "string" ? e : ((e as Error)?.message ?? "");
    // 古いアプリ（コマンドが無い・許されていない）
    if (/not found|not allowed|unknown command/i.test(msg)) return null;
    throw new Error(msg || "desktop_setup_failed");
  }
}

/** AI 詳細パネルを開いた週ボードへの path（メニューバーの → / ⌘⏎。D-067） */
export function panelPath(workItemId: string, o: { answer?: boolean } = {}): string {
  return `/board?panel=${encodeURIComponent(workItemId)}${o.answer ? "&answer=1" : ""}`;
}

/**
 * path の `panel=<workItemId>` を取り出し、残りの path を返す（main.tsx が読み込み時と __turnlaneOpen で使う）。
 * 無ければ panel は null
 */
export function takePanelParam(href: string): {
  path: string;
  panel: string | null;
  /** 「答える」の節も開く（`&answer=1`。D-238） */
  answer: boolean;
} {
  const u = new URL(href, "http://x");
  const panel = u.searchParams.get("panel");
  const answer = u.searchParams.get("answer") === "1";
  u.searchParams.delete("answer");
  if (panel === null)
    return { path: `${u.pathname}${u.search}${u.hash}`, panel: null, answer: false };
  u.searchParams.delete("panel");
  return {
    path: `${u.pathname}${u.search}${u.hash}`,
    panel: panel || null,
    answer: answer && !!panel,
  };
}

/** クイック入力の既定のキー（D-056 (2)。設定 desktop.quick_add_shortcut で変えられる） */
export const DEFAULT_QUICK_ADD_SHORTCUT = "Alt+Shift+Space";

const MOD: Record<string, string> = {
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  ctrl: "⌃",
  control: "⌃",
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
  cmdorctrl: "⌘",
  commandorcontrol: "⌘",
};

/** "Alt+Shift+Space" → "⌥⇧Space"（Rust の shortcut::label と同じ） */
export function shortcutLabel(accel: string | null | undefined): string {
  return (accel || DEFAULT_QUICK_ADD_SHORTCUT)
    .split("+")
    .map((p) => MOD[p.trim().toLowerCase()] ?? p.trim())
    .join("");
}
