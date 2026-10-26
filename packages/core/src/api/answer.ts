/**
 * Turnlane から答える（D-238、ADR 0019。m2-api 31章）の API の型。
 * - GET /api/work-items/:id/wait: 今開いている待ちの中身（問いの全文は表示の瞬間に読む。保存しない）と届け先。`no-store`
 * - POST /api/work-items/:id/answer: 答えをその端末のタブ（ペイン）に文字として届け、タブを前に出す。答えは保存しない
 */
import type { EpochMs } from "./common.ts";
import type { GlancePermission, GlanceUnavailable } from "./glance.ts";
import type { OpenLanding } from "./open.ts";
import type { ErrorKind } from "./work-items.ts";

/**
 * 届け方（送れる端末）。tmux = send-keys、iterm = AppleScript の write text、terminal = ターミナル.app の AppleScript の
 * do script（tty の一致するタブに。D-243）、ghostty = Ghostty 1.3 の AppleScript の input text と send key（「開く」と同じ
 * 目印で選んだ端末に。D-244）、orca = 同梱の CLI の terminal send
 */
export type AnswerVia = "tmux" | "iterm" | "terminal" | "ghostty" | "orca";

/**
 * 送れない理由
 * - not_live: セッションが動いていない（終わった・調べられない）
 * - unsupported: その端末には送る口が無い（Warp・Kitty、AppleScript を切っている・1.3 より古い Ghostty など。tmux の中なら
 *   送れる）
 * - not_found: 端末のタブ（ペイン）が見つからない（Orca で同じフォルダの端末が複数ある、Ghostty の目印の端末が 1 つに
 *   決まらない等）
 * - off: 設定「Turnlane から答える」がオフ
 */
export type AnswerUndeliverable = "not_live" | "unsupported" | "not_found" | "off";

export interface AnswerDelivery {
  deliverable: boolean;
  via: AnswerVia | null;
  /** 端末のアプリの表示名（分からなければ null） */
  terminal: string | null;
  /** 送るボタンに添える届け先（`Orca · タブ` / `Ghostty · タブ` / `Ghostty · main:1.0`）。送れなければ null */
  landing: string | null;
  /** 改行をそのまま送れる（tmux の Claude Code は Ctrl+J で改行。ほかは 1 行に畳む） */
  multiline: boolean;
  reason?: AnswerUndeliverable;
}

/** 待ちの種類（問い = AI の問い・AskUserQuestion、許可 = 許可待ち、エラー = エラーで止まった） */
export type WaitKind = "question" | "ask" | "permission" | "error" | "none";

/**
 * 答える対象の待ち（D-240）。開いているフォローアップ（approve / resume_error / reply）→ 無ければセッションの待ち
 * （needs_input、your_turn の問い。猶予の間も）で決める（core の `derive.openWaitOf`）。`GET /api/queue` の item と
 * `GET /api/work-items/:id` に付く。web の「答える」・`a`・右クリックはこれがあるときだけ出す
 */
export interface OpenWaitBrief {
  kind: Exclude<WaitKind, "none">;
  /** 待ちのターン */
  turnId: string | null;
  /** 答える先のフォローアップ（猶予の間の問いなど、フォローアップの無い待ちは null） */
  followUpId: string | null;
}

export interface WaitResponse {
  workItemId: string;
  /** 答える先のフォローアップ（無ければ null） */
  followUpId: string | null;
  kind: WaitKind;
  /** AI の問いの全文（2,000 字まで。伏せ字済み）。AskUserQuestion は問いを改行でつないだもの */
  question?: { text: string; truncated: boolean; masked: boolean };
  /** 選択肢（番号は 1 始まり。押すと入力欄に番号が入る） */
  options?: { n: number; label: string }[];
  /** 許可待ちのツールと中身（glance と同じ伏せ字） */
  permission?: GlancePermission;
  /** 許可待ちで「許可する」（1 を送る）を出すか（Claude Code の許可のダイアログだけ） */
  canAllow: boolean;
  error?: ErrorKind;
  unavailable?: GlanceUnavailable;
  delivery: AnswerDelivery;
  readAt: EpochMs;
}

/** 答え: 文（text）か、許可待ちの「許可する」（allow） */
export type AnswerInput = { text: string } | { allow: true };

export interface AnswerResult {
  delivered: boolean;
  /**
   * 送った後 3 秒以内に記録が進んだ（新しい自分の指示・許可の結果が現れた）。Orca は CLI が送信を観測したときも true
   */
  confirmed: boolean;
  via: AnswerVia;
  /** 端末のアプリの表示名 */
  app: string;
  /** 行に出す短い届け先（`Orca · タブ` / `iTerm2 · タブ 3`） */
  landing: string;
  /** タブを前に出した着地（D-217。前に出せなかった・確かめられて前に出さなかった（D-241）ら null） */
  focus: OpenLanding | null;
  /** 知らせの文（デーモンの言語） */
  message: string;
  /** 1 行に畳んだ（改行を空白にした） */
  folded: boolean;
}
