/**
 * タスクから開く（D-059。ux-mvp 4.11、m2-api 13章）: タスクの種類ごとの既定の開き先と `o` のメニューの並び。
 * web（ホバーのアイコン）とデーモン（解決）が同じ表を使う。
 */
import type { FollowUpKind } from "./api/common.ts";
import type { OpenAction, OpenLanding } from "./api/open.ts";
import type { Locale } from "./i18n/task-title.ts";

export const OPEN_ACTIONS: readonly OpenAction[] = [
  "pr",
  "pr_files",
  "diff",
  "editor",
  "finder",
  "terminal",
  "session",
  "codex_app",
  "copy_resume",
];

/** 種類ごとの開き方（先頭が既定の ⏎） */
const MENU: Record<FollowUpKind, readonly OpenAction[]> = {
  review_pr: ["pr", "pr_files", "editor"],
  merge_pr: ["pr", "pr_files", "editor"],
  check_changes: ["diff", "editor", "finder", "terminal"],
  reply: ["session", "editor", "copy_resume"],
  approve: ["session", "editor", "copy_resume"],
  resume_error: ["session", "editor", "copy_resume"],
};

/** カードだけ（AI 詳細パネル）のときの並び。既定を先頭へ動かして使う */
const ALL: readonly OpenAction[] = [
  "session",
  "codex_app",
  "pr",
  "pr_files",
  "diff",
  "editor",
  "finder",
  "terminal",
  "copy_resume",
];

export function openMenu(kind: FollowUpKind | null): readonly OpenAction[] {
  return kind ? MENU[kind] : ALL;
}

export function defaultOpenAction(kind: FollowUpKind): OpenAction {
  return MENU[kind][0] as OpenAction;
}

/** アプリの設定（turnlane config の open.*）。並びは検出時のフォールバックの順 */
export const OPEN_APP_IDS = {
  editor: ["zed", "cursor", "vscode", "sublime"],
  terminal: ["ghostty", "warp", "iterm", "terminal", "orca"],
  diff: ["github_desktop", "fork", "tower"],
} as const;

export const OPEN_APP_DEFAULTS = {
  editor: "zed",
  terminal: "ghostty",
  diff: "github_desktop",
} as const;

/**
 * 着地・届け先の文に出す端末のアプリの名前。ターミナル.app は日本語の macOS での名前（「ターミナル」）に合わせる
 * （D-243）。ほかはそのまま
 */
export function terminalAppName(app: string, locale: Locale): string {
  return app === "Terminal" && locale === "ja" ? "ターミナル" : app;
}

/**
 * 動いているセッションを前に出したときの着地の文（D-214 (4)。desktop-shell.md 4.4）。知らせ（トースト）と
 * POST /api/open の message に使う。事実だけを言う（見つからなかったときは「見つかりませんでした」と言う）
 */
export function openLandingText(appRaw: string, l: OpenLanding, locale: Locale): string {
  const app = terminalAppName(appRaw, locale);
  const text = landingText(app, l, locale);
  // 「ターミナル」はカタカナなので助詞の前に空白を入れない（英字のアプリ名だけ空白で区切る）
  return app === appRaw ? text : text.replaceAll(`${app} `, app);
}

function landingText(app: string, l: OpenLanding, locale: Locale): string {
  const ja = locale === "ja";
  // 「iTerm2 のタブ 3 を」「Ghostty のタブを」/ "iTerm2 tab 3" "the Ghostty tab"
  const tabJa = l.tab !== null ? `${app} のタブ ${l.tab} ` : `${app} のタブ`;
  const tabEn = l.tab !== null ? `${app} tab ${l.tab}` : `the ${app} tab`;
  const n = l.candidates ?? 0;
  if (l.level === "tab") {
    if (l.miss === "ambiguous" && n > 1)
      return ja
        ? `${app} で同じフォルダのタブが ${n} 個あり、${l.tab !== null ? `タブ ${l.tab} ` : "1 つ目"}を前に出しました。`
        : `${app} has ${n} tabs in this folder — brought ${l.tab !== null ? `tab ${l.tab}` : "the first one"} to the front.`;
    if (l.pane)
      return ja
        ? `${tabJa}で tmux の ${l.pane} を選びました。`
        : `Selected tmux pane ${l.pane} in ${tabEn}.`;
    return ja ? `${tabJa}を前に出しました。` : `Brought ${tabEn} to the front.`;
  }
  if (l.pane)
    return ja
      ? `tmux の ${l.pane} を選び、${app} を前に出しました。タブは見つかりませんでした。`
      : `Selected tmux pane ${l.pane} and brought ${app} to the front — couldn't find its tab.`;
  if (l.miss === "unsupported")
    return ja
      ? `${app} を前に出しました。${app} ではタブまでは選べません。`
      : `Brought ${app} to the front — ${app} can't select a tab.`;
  return ja
    ? `${app} を前に出しました。タブは見つかりませんでした。`
    : `Brought ${app} to the front — couldn't find the tab.`;
}

/**
 * 行に残す短い形（「対応中 · iTerm2 · タブ 3」の後ろ半分）。タブまで行けたが番号が分からなければ「タブ」（`Ghostty · タブ`。
 * 答えるの届け先の言葉と同じ。D-244）。タブまで行けなかったときはアプリ名だけ
 */
export function openLandingShort(appRaw: string, l: OpenLanding, locale: Locale): string {
  const app = terminalAppName(appRaw, locale);
  if (l.level !== "tab") return l.pane ? `${app} · ${l.pane}` : app;
  if (l.pane) return `${app} · ${l.pane}`;
  const tab = locale === "ja" ? "タブ" : "tab";
  return l.tab !== null ? `${app} · ${tab} ${l.tab}` : `${app} · ${tab}`;
}
