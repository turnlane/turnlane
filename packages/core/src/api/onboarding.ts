/** オンボーディングの API（onboarding.md 5.4、M6-18〜M6-20）と更新確認（M6-12） */
import type { Onboarding, OnboardingStep, OnboardingStepStatus } from "../onboarding.ts";
import type { EpochMs, LocalDate } from "./common.ts";

/** GET /api/onboarding */
export interface OnboardingView extends Onboarding {
  /** 取り込みのゲートが開いているか（consentedAt があるか） */
  consented: boolean;
  /** 同意の後の最初の取り込み（直近7日。D-181）が一度終わったか */
  backfillDone: boolean;
}

/** PUT /api/onboarding/step */
export interface OnboardingStepBody {
  step: OnboardingStep;
  status: OnboardingStepStatus;
}

/** 検出した取り込み元（GET /api/onboarding/detect）。件数はファイルの数と更新時刻だけで数える（中身は開かない） */
export interface DetectedSourceView {
  id: string;
  tool: string;
  /** 'default' かディレクトリ名から（~/.claude-acme → acme） */
  label: string;
  rootPath: string;
  enabled: boolean;
  /** 直近7日（6日前の論理日の始まり以降）に更新されたセッションのファイル数。取り込む範囲と同じ（D-181） */
  sessions7d: number;
  /** 最も新しいファイルの更新時刻 */
  lastActivityAt: EpochMs | null;
  /** 読めない（権限など）ときは false と理由 */
  readable: boolean;
  reason: string | null;
  /** 設定ディレクトリを手で足したもの（Choose a folder…） */
  manual: boolean;
}

export interface DetectResponse {
  sources: DetectedSourceView[];
  /** Claude Desktop（Code タブのセッションは Claude Code の設定ディレクトリに残る。Cowork は対象外） */
  claudeDesktop: { present: boolean; viaSourceId: string | null };
  /** 利用者のホーム（画面でパスを ~ で短く出す） */
  home: string;
  /** デーモンの今（「last used …」の日数） */
  now: EpochMs;
}

/** POST /api/onboarding/consent */
export interface ConsentBody {
  /** 取り込む元（チェックした元）。入っていない元は enabled=0 にする */
  enabledSourceIds: string[];
}

/** POST /api/onboarding/sources（Choose a folder…） */
export interface AddSourceBody {
  path: string;
}

/** SSE `import_progress` と GET /api/onboarding/progress（5.3） */
export interface ImportProgress {
  /** 直近7日（論理日）。新しい日が先頭 */
  days: { date: LocalDate; state: "pending" | "importing" | "done" }[];
  sources: {
    id: string;
    state: "pending" | "importing" | "done";
    /** 読めなかったファイルの数 */
    skipped: number;
  }[];
  /** 7日分が終わった時刻（終わるまで null）。それより前は取り込まない（D-181） */
  doneAt: EpochMs | null;
}

/** GET /api/onboarding/summary?days=7（O3 の1行。在席・カレンダーに依存しない値だけ） */
export interface OnboardingSummary {
  from: LocalDate;
  to: LocalDate;
  days: number;
  /** AI の稼働時間の合計 */
  aiMs: number;
  /** AI の作業の数（O3 の列のラベルの数。同じカードでも日が違えば別に数える） */
  cards: number;
  /** AI が人を待った回数（待ち区間の数） */
  waits: number;
  /** その期間の日がすべて取り込み済みか（false なら数字は途中のもの。画面は出さない） */
  complete: boolean;
}

/** GET /api/onboarding/board?days=7（O3 の日ごとの列。新しい日が先頭） */
export interface OnboardingBoard {
  from: LocalDate;
  to: LocalDate;
  days: {
    date: LocalDate;
    /** その日のラベルの AI 時間の和 */
    aiMs: number;
    /** その日に動いた AI の作業（AI 時間の長い順）。持ち越しは入れない */
    items: {
      id: string;
      title: string | null;
      status: string;
      repoRoot: string | null;
      scratch: boolean;
      branch: string | null;
      prRef: string | null;
      aiMs: number;
      /** その日の最初のターンの始まりと最後のターンの終わり（ホバー） */
      startAt: EpochMs | null;
      endAt: EpochMs | null;
    }[];
  }[];
}

/** POST /api/onboarding/hooks・/api/onboarding/mcp の入力（dryRun なら書かずに結果だけ返す。O5・O5a の「変更を見る」） */
export interface InstallBody {
  dryRun?: boolean;
}

/** hooks のインストールの対象ごとの結果（O5。同意した Claude Code / Codex の設定ディレクトリごと。D-122） */
export interface HooksInstallTarget {
  sourceId: string;
  tool: "claude_code" | "codex";
  /** 書くファイル（settings.json / hooks.json） */
  file: string;
  /** 足す・直す・そのままのイベント名 */
  added: string[];
  updated: string[];
  unchanged: string[];
  /** 書いた（dryRun なら書くことになる） */
  changed: boolean;
  backup: string | null;
  /** 読めない・書く直前に変わった・書けない（短いコード。ファイルの中身は含めない） */
  error: "unreadable" | "changed" | "write_failed" | null;
  /** hooks が無効になっている理由（disableAllHooks、config.toml の hooks = false など） */
  disabled: string[];
  /** Codex: /hooks での承認が要る（新しく足した・直した、または承認が無い） */
  needsApproval: boolean;
}

export interface HooksInstallResponse {
  dryRun: boolean;
  /** hooks に書いた turnlane のパス */
  cli: string;
  targets: HooksInstallTarget[];
  failed: number;
}

/** MCP の登録の対象ごとの結果（O5a。D-145） */
export interface McpInstallTarget {
  sourceId: string;
  tool: "claude_code" | "codex";
  file: string;
  action: "added" | "updated" | "none";
  changed: boolean;
  backup: string | null;
  error: "unreadable" | "not_object" | "changed" | "unsafe_toml" | null;
}

export interface McpInstallResponse {
  dryRun: boolean;
  cli: string;
  targets: McpInstallTarget[];
  failed: number;
}

/**
 * POST /api/onboarding/calendar/connect（O4 の主ボタン）: ヘルパを常駐させ、カレンダーの許可のダイアログを出す。
 * 結果は待たず、画面は GET /api/calendar/status で確かめる。unavailable はこのデーモンにその手段が無い
 * （テスト・手段を渡していない起動）
 */
export interface CalendarConnectResponse {
  started: boolean;
  /** unavailable: 手段が無い。failed: 始めてすぐ失敗した（ヘルパを置けないなど） */
  reason: "unavailable" | "failed" | null;
  /** 始めた接続（started のとき。failed のときは失敗の中身） */
  attempt?: CalendarConnectAttempt | null;
}

/**
 * GET /api/onboarding/calendar/connect: 最後に始めたカレンダーの接続の結果（onboarding.md 4.4。デーモンの起動からの1件だけ）。
 * running: 許可のダイアログの結果を待っている（turnlane calendar authorize が終わっていない）。
 * failed: 終了コードが 0 でない・起動できなかった（detail は turnlane の stderr の要約。英語。会話本文は含まない）
 */
export interface CalendarConnectAttempt {
  id: number;
  state: "running" | "ok" | "failed";
  startedAt: number;
  finishedAt: number | null;
  /** 終了コード（起動できなかったときは null） */
  code: number | null;
  detail: string | null;
}

/** GET /api/update（M6-12） */
export interface UpdateStatus {
  /** 設定 update.check */
  enabled: boolean;
  /** このビルドに確認先があるか（無ければ確認しない） */
  configured: boolean;
  current: string;
  latest: { version: string; url: string; sha256: string | null } | null;
  /** latest が current より新しい */
  available: boolean;
  checkedAt: EpochMs | null;
  /** 最後の確認の失敗（短いコード） */
  error: string | null;
  /**
   * 入れ方（M6-17）: homebrew（cask。`brew upgrade --cask turnlane` を案内）、download（Releases の zip。ページを開く）、
   * dev（開発時の配置。案内しない）
   */
  channel?: "homebrew" | "download" | "dev";
  /** homebrew のときの更新のコマンド（コピーできる形） */
  upgradeCommand?: string | null;
  /** download のときに開く最新リリースのページ（それ以外は null。古いデーモンには無い） */
  releasesUrl?: string | null;
  /**
   * ボードの更新の知らせを閉じた版（POST /api/update/dismiss。デーモンのプロセスの中だけ覚え、次の起動で忘れる）。
   * 古いデーモンには無い
   */
  dismissed?: string | null;
  /**
   * 確認しない理由（null なら確認する）。setting は update.check、custom_build は拡張を組み込んだビルド、
   * dev_install は開発時の配置（公開版を勧めない）
   */
  off?: "setting" | "custom_build" | "dev_install" | null;
}
