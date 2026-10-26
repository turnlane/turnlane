/** タスクから AI に頼む（D-107・D-109 の無料の部分。m2-api 27章、plan §B）の API の型 */
import type { EpochMs } from "./common.ts";
import type { ErrorKind } from "./work-items.ts";

export type AiLaunchTool = "claude_code" | "codex";

/**
 * タスクから見た頼んだ AI の状態（plan §B.2）:
 * starting（起動を待っている・セッションを探している）/ running / needs_input（許可・質問で止まっている）/
 * your_turn（返答待ち）/ done_check（AI 完了 · 確認）/ error / unlinked（セッションが見つからない）/ failed（起動できなかった）
 */
export type TaskAiState =
  | "starting"
  | "running"
  | "needs_input"
  | "your_turn"
  | "done_check"
  | "error"
  /** 利用枠の上限待ち（AI 項目は done・理由 rate_limit。errorKind は rate_limit）。古い応答には無い */
  | "limit"
  | "unlinked"
  | "failed";

/** タスクに付く「頼んだ AI」（最後の依頼1件） */
export interface TaskAiView {
  launchId: string;
  tool: AiLaunchTool;
  state: TaskAiState;
  /** 紐づいた AI 項目（紐づく前は null） */
  workItemId: string | null;
  /** 開いている自分の番（帯に出ている間） */
  followUpId: string | null;
  repoRoot: string;
  branch: string | null;
  worktreePath: string | null;
  /** その状態になった時刻（starting は依頼した時刻） */
  since: EpochMs;
  /** failed の理由（コード。not_claimed / cli_missing / terminal） */
  failReason: string | null;
  /**
   * error のとき、StopFailure の hook のエラーの種類（D-116。利用枠で止まったら rate_limit）。上限待ち（limit）は rate_limit。
   * それ以外・hook の無いエラーは null。古い応答には無い（任意）
   */
  errorKind?: ErrorKind | null;
  /**
   * unlinked のとき、セッションが見つからなかった理由（exited: AI の CLI がセッションを作らずに終わった / untrusted: Claude Code が
   * そのフォルダを信頼していない / no_session: 動いているがセッションが来ない）。古い応答・古い依頼には無い（任意）
   */
  unlinkedReason?: "exited" | "untrusted" | "no_session" | null;
  /** turnlane ai run が知らせた AI の CLI の終わり（終了コードと、始めてから終わるまでの ms）。終わっていなければ null（任意） */
  exit?: { code: number; afterMs: number } | null;
}

export interface AiTemplateView {
  /** 組み込みは `builtin:<key>` */
  id: string;
  name: string;
  builtin: boolean;
  body: string;
  tool: AiLaunchTool | null;
  readOnly: boolean;
  /** worktree の既定（null = プロジェクトの既定） */
  worktree: boolean | null;
}

export interface LaunchRepoOption {
  path: string;
  name: string;
  /** git のリポジトリか（worktree を選べるか） */
  git: boolean;
  /** worktree の既定（プロジェクトの設定。git でなければ false） */
  worktreeDefault: boolean;
  /** 属するプロジェクトの色（無ければ null） */
  color: string | null;
  /** タスクのプロジェクトの既定のリポジトリ（「（プロジェクトの既定）」と添える） */
  projectDefault: boolean;
  /** 属するプロジェクトの Claude のアカウントの既定（設定ディレクトリ。無ければ null。D-122） */
  claudeAccount: string | null;
}

/**
 * Claude のアカウント（D-122）: 取り込みで検出した Claude Code の設定ディレクトリ（~/.claude、~/.claude-*、
 * $CLAUDE_CONFIG_DIR）。起動するときに CLAUDE_CONFIG_DIR に入れる。ログインしているかは判定しない（認証のファイルを開かない）
 */
export interface ClaudeAccountOption {
  /** 設定ディレクトリの絶対パス */
  path: string;
  /** 表示名（設定で変えた名前 → ディレクトリ名から。`~/.claude` は null = 「既定」と出す） */
  name: string | null;
}

/** 設定 > AI の Claude のアカウントの一覧（起動の選択肢から外したものも含む） */
export interface ClaudeAccountView {
  path: string;
  /** 表示用のパス（ホームは `~`） */
  displayPath: string;
  /** ディレクトリ名からの名前（`~/.claude` は null） */
  dirName: string | null;
  /** 設定で変えた名前（無ければ null） */
  customName: string | null;
  /** 起動の選択肢から外した */
  hidden: boolean;
}

/** GET /api/ai/launch-options?taskId= : 依頼のポップオーバーの選択肢と既定（前回選んだもの） */
export interface AiLaunchOptions {
  repos: LaunchRepoOption[];
  /** タスクのプロジェクトの最初のリポジトリ → 前回のリポジトリ → 先頭 */
  defaultRepo: string | null;
  /** 入っているツールだけ（Codex が無ければ出さない。レビュー your-turn-v1 の 4） */
  tools: AiLaunchTool[];
  /** 前回選んだもの（入っていなければ入っている最初のもの） */
  defaultTool: AiLaunchTool | null;
  templates: AiTemplateView[];
  defaultTemplateId: string;
  /** 開く端末（表示名。無ければ null = コピーだけ） */
  terminal: string | null;
  /**
   * Claude のアカウントの選択肢（起動の選択肢から外したものを除く。D-122）。2つ以上のときだけ「アカウント」の行を出す
   */
  claudeAccounts: ClaudeAccountOption[];
  /** 既定のリポジトリのプロジェクトの既定 → タスクのプロジェクトの既定 → 前回選んだもの → 先頭 */
  defaultClaudeAccount: string | null;
}

export interface AiLaunchInput {
  taskId: string;
  repo: string;
  tool: AiLaunchTool;
  templateId?: string | undefined;
  worktree: boolean;
  /** 指示（任意。保存しない） */
  instruction?: string | undefined;
  /** Claude のアカウント（設定ディレクトリ。省略は既定。Claude Code のときだけ使う。D-122） */
  claudeAccount?: string | undefined;
}

export type AiLaunchOutcome = "opened" | "opened_copied" | "copied";

export interface AiLaunchResult {
  launchId: string;
  outcome: AiLaunchOutcome;
  /** 開いた端末の表示名 */
  app: string | null;
  /** コピーしたとき（opened_copied / copied）のコマンド。UI もクリップボードへ書く */
  command: string | null;
  cwd: string;
  worktreePath: string | null;
  branch: string | null;
}

/** POST /api/ai/launches/:id/claim（turnlane ai run が1回だけ受け取る）。argv[0] はツールのコマンド名 */
export interface AiLaunchClaim {
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  /** 子の環境から消す変数（既定のアカウント `~/.claude` を選んだときの CLAUDE_CONFIG_DIR。D-122） */
  unsetEnv?: string[];
}

export type CiState = "pass" | "fail" | "pending" | "none";
export type TestState = "none" | "idle" | "running" | "passed" | "failed";

/** 1件ずつの確認支援（D-109 の無料。plan §B.5）: 差分の量・テスト・CI・worktree */
export interface WorkCheckView {
  workItemId: string | null;
  launchId: string | null;
  /** 差分（base...branch と未コミット）。分からなければ null */
  diff: {
    base: string;
    files: number;
    additions: number;
    deletions: number;
    commits: number;
    /** 未コミットの変更のファイル数（worktree があるときだけ。無ければ null） */
    uncommitted: number | null;
    /** ディレクトリごとのファイル数（多い順に5つまで） */
    dirs: { dir: string; files: number }[];
  } | null;
  test: {
    /** プロジェクトの設定のコマンド（無ければ null で、テストの行を出さない） */
    command: string | null;
    state: TestState;
    at: EpochMs | null;
    exitCode: number | null;
    /** 最後の50行（メモリだけ。デーモンを再起動すると消える） */
    tail: string[];
  };
  /** PR の CI（gh。PR が無い・gh が無ければ null） */
  ci: { state: CiState; total: number; failing: string[] } | null;
  pr: {
    number: number;
    url: string;
    additions: number | null;
    deletions: number | null;
    files: number | null;
  } | null;
  /** Turnlane が作った worktree（無ければ null） */
  worktree: {
    path: string;
    branch: string | null;
    exists: boolean;
    cleanedAt: EpochMs | null;
  } | null;
}

/** POST /api/ai/launches/:id/cleanup の結果 */
/**
 * 依頼の差分の中身（拡張の `review.diff`）。差分の範囲は WorkCheckView の diff と同じ（base からの分岐点 → worktree なら
 * 作業ツリーまで、なければブランチの先端まで）。会話・題名・メモは含まない
 */
export interface WorkDiffView {
  base: string;
  /** ファイルごとの追加・削除（バイナリは null）。追加・削除の多い順に maxFiles まで */
  files: { path: string; additions: number | null; deletions: number | null }[];
  /** 変更のあったファイルの数（maxFiles で切る前。まだ git に入れていない新しいファイルを含む） */
  totalFiles: number;
  additions: number;
  deletions: number;
  /** まだ git に入れていない新しいファイル（worktree のときだけ。名前だけで、中身は抜粋に入れない） */
  untracked: string[];
  /** unified 形式（前後2行）の抜粋。ファイルごと・全体で上限まで（バイナリは入れない） */
  excerpt: string;
  /** ファイルの一覧か抜粋を上限で切った */
  truncated: boolean;
}

export interface WorktreeCleanupResult {
  removed: boolean;
  /** 消さなかった理由（dirty: 未コミットあり / unmerged: 取り込まれていない） */
  reason: "dirty" | "unmerged" | "missing" | "failed" | null;
  uncommitted: number | null;
}

/**
 * 完了のときの片付け（POST /api/ai/launches/:id/finish）。closeTerminal: AI を終了してタブを閉じる。removeWorktree: worktree を
 * 消す。force: 取り込まれていない（unmerged・dirty）worktree も消す（完了のシートで明示したときだけ）
 */
export interface LaunchFinishInput {
  closeTerminal: boolean;
  removeWorktree: boolean;
  force: boolean;
}

/**
 * タブを閉じた結果: closed（閉じた）/ not_closable（送る口の無い端末。何もしない）/ ai_still_running（終了の指示を送ったが
 * 待つ間に終わらなかった。タブは閉じない）/ failed（端末が見つからない・その起動の端末と確かめられない・送れなかった）
 */
export type LaunchTerminalOutcome = "closed" | "not_closable" | "ai_still_running" | "failed";

/**
 * タブを閉じられなかった理由: not_found（端末が見つからない・その起動のものと確かめられない）/ ai_waiting（AI が許可・
 * 選択のダイアログで待っている。Enter が選択になるので送らない）/ send_failed（送れなかった）/ unsupported（送る口の無い端末）/
 * not_exited（終わらなかった）
 */
export type LaunchFinishReason =
  | "not_found"
  | "ai_waiting"
  | "send_failed"
  | "unsupported"
  | "not_exited";

export interface LaunchFinishResult {
  /** タブを閉じなかった（closeTerminal: false）なら null */
  terminal: LaunchTerminalOutcome | null;
  reason: LaunchFinishReason | null;
  /** 端末の表示名（分かれば） */
  app: string | null;
  /** worktree を消さなかった（removeWorktree: false・worktree が無い）なら null */
  worktree: WorktreeCleanupResult | null;
}

/** 完了のシートに出す 1 件（起動が生きている依頼） */
export interface LaunchFinishItem {
  launchId: string;
  taskId: string;
  tool: AiLaunchTool;
  /** AI のプロセス（turnlane ai run）がまだ動いている */
  aiRunning: boolean;
  /**
   * 残っている worktree（無ければ null）。state: clean = 取り込み済みで未コミットなし（そのまま消せる）/ unmerged = 取り込まれて
   * いない / dirty = 未コミットの変更がある（unmerged・dirty は強制で消す）
   */
  worktree: { path: string; branch: string | null; state: "clean" | "unmerged" | "dirty" } | null;
}

/** GET /api/ai/finish-plan?taskIds= : 完了にするタスクのうち、起動が生きている依頼（無ければ空。シートを出さない） */
export interface LaunchFinishPlan {
  launches: LaunchFinishItem[];
}

/** GET /api/ai/launches/:id/candidates : 紐づかなかったときに選ぶ候補（直近のセッション） */
export interface LaunchCandidate {
  sessionId: string;
  tool: AiLaunchTool;
  title: string | null;
  cwd: string | null;
  startedAt: EpochMs;
}
