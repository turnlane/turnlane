/** タスクから開く（D-059。m2-api 13章、ux-mvp 4.11）の API の型 */
import type { EpochMs } from "./common.ts";

export type OpenAction =
  | "pr"
  | "pr_files"
  | "diff"
  | "editor"
  | "finder"
  | "terminal"
  | "session"
  /** Codex のアプリでスレッドを開く（codex://threads/<id>。Codex のセッションで、アプリが入っているときだけ。D-135） */
  | "codex_app"
  | "copy_resume"
  /** 報告にあった開く先（http(s) かアプリの URL スキーム。報告の項目だけ。ADR 0021） */
  | "report_url";

export type OpenAppKind = "editor" | "terminal" | "diff";

/** `o` のメニューの1行。app は実際に開くアプリの表示名（フォールバック後）。ブラウザ・コピーは null */
export interface OpenOption {
  action: OpenAction;
  app: string | null;
}

/** options[0] が既定（⏎）。開けるものだけを並べる */
export interface OpenOptions {
  default: OpenAction | null;
  options: OpenOption[];
}

export type OpenOutcome = "opened" | "focused" | "typed" | "opened_copied" | "copied";

/**
 * 最初に試した開き方が失敗して別の開き方に落ちた理由（B-5。D-193）。UI はこれで文を選ぶ。
 * - automation_denied: 端末に入力しようとしてオートメーションの許可が無かった（osascript -1743）
 * - automation_timeout: 許可の確認のダイアログで待たされて打ち切った（OSA_TIMEOUT_MS）
 * - no_terminal: 設定の端末が入っていないので別の端末で開いた
 */
export type OpenFallbackReason = "automation_denied" | "automation_timeout" | "no_terminal";

/**
 * 動いているセッションを開いたとき、どこまで絞って着地したか（D-214 (4)。desktop-shell.md 4.4、ADR 0014 の追記）。
 * 探す順は tty → tmux のペイン → cwd → アプリ。
 * - level: tab = その端末のタブ（ペイン）を前に出した / app = アプリを前に出しただけ
 * - by: 何で見つけたか（tty = 端末のタブの tty、cwd = 作業フォルダの一致、handle = Orca の端末のハンドル（hooks が
 *   記録した ORCA_TERMINAL_HANDLE。D-238）。app のときは null）
 * - tab: タブの番号（1 始まり。端末が返したときだけ）
 * - pane: tmux のペイン（`セッション:ウインドウ.ペイン`。tmux の中のときだけ。tmux で選べたもの）
 * - miss: 絞り切れなかった理由。app のとき not_found（見つからない）/ unsupported（その端末ではタブを選べない）、
 *   tab のとき ambiguous（cwd で一致したタブが複数あり、1 つ目を前に出した）
 * - candidates: ambiguous のとき、cwd で一致したタブの数
 */
export interface OpenLanding {
  level: "tab" | "app";
  by: "tty" | "cwd" | "handle" | null;
  tab: number | null;
  pane: string | null;
  miss: "not_found" | "ambiguous" | "unsupported" | null;
  candidates?: number | null;
}

export interface OpenResult {
  action: OpenAction;
  outcome: OpenOutcome;
  app: string | null;
  /** コピーしたとき（opened_copied / copied）の resume コマンド。UI もクリップボードへ書く */
  command: string | null;
  /** フォローアップに対応中の印を付けた時刻（followUpId で開いたとき） */
  engagedAt: EpochMs | null;
  /** 別の開き方に落ちた理由と、落ちる前に試したアプリ（無ければ null。古い応答には無い） */
  fallback?: { reason: OpenFallbackReason; app: string | null } | null;
  /** 動いているセッションを前に出したときの着地（outcome が focused のときだけ。古い応答には無い） */
  landing?: OpenLanding | null;
  /** 着地を言葉にしたもの（デーモンの言語。`openLandingText`）。focused 以外は null */
  message?: string | null;
}

export interface OpenAppChoice {
  /** 設定の値（open.editor など） */
  selected: string;
  /** 実際に使うアプリ（未インストールならフォールバック先）。null は無い（差分ツールはエディタ、エディタは Finder へ） */
  effective: string | null;
  installed: { id: string; name: string }[];
}

export interface OpenAppsResponse {
  editor: OpenAppChoice;
  terminal: OpenAppChoice;
  diff: OpenAppChoice;
}
