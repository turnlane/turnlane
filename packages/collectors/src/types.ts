/**
 * ソースアダプタの公開 IF（phase0-plan 3.1）。互換性のない変更をしたら ADAPTER_API_VERSION を上げる。
 * このファイルは型と定数だけを持つ。
 */
import type { MetaOnlyLogger } from "./logger.ts";

/** NormalizedEvent / SourceAdapter に互換性のない変更をしたら上げる。 */
export const ADAPTER_API_VERSION = 1 as const;

/**
 * アダプタの識別子。/^[a-z][a-z0-9_]{1,31}$/（DB の CHECK と同じ書式）。
 * 同梱: 'claude_code' | 'codex' | 'hook_spool'。列挙型にしないのは、アダプタの追加で
 * core / daemon / DB のマイグレーションを要らなくするため。
 */
export type ToolId = string & { readonly __brand: "ToolId" };

export interface DetectedRoot {
  tool: ToolId;
  /** 絶対パス */
  rootPath: string;
  /** ディレクトリ名から導出した表示用ラベル（例 'default'） */
  profileLabel: string;
  /** 'has projects/' など（存在確認のみ） */
  evidence: string[];
}

export interface StreamSpec {
  /** ingest_cursor.stream_key（ルートからの相対パス） */
  key: string;
  kind: "jsonl" | "json_snapshot" | "sqlite";
  /** 絶対パス */
  path: string;
  /** 初回取り込みの順序 */
  priority: "live" | "recent" | "backfill";
}

export interface WatchSpec {
  dir: string;
  recursive: boolean;
  match: (absPath: string) => boolean;
  /** 取りこぼし対策の定期再走査（mtime 比較）の間隔 */
  reconcileEveryMs: number;
  /**
   * 監視の通知が来ない書き込みのための軽い走査の間隔（無ければしない）。macOS の fs.watch は、開いたままのファイルへの
   * 追記を閉じるまで知らせない。この監視先の最近のストリーム（列挙で live / recent のものと、監視で作られたもの）の
   * mtime だけをこの間隔で見て、変わったものを読む（中身は読まない）
   */
  pollEveryMs?: number;
}

export interface Cursor {
  dev?: number;
  inode?: number;
  size?: number;
  mtimeMs?: number;
  byteOffset: number;
  watermark?: string;
  /** パーサ固有の継続状態（JSON 化できるもの） */
  carry?: unknown;
  parserVersion: number;
}

export interface ReadContext {
  now: number;
  /** 1回で読む上限（初回の巨大ファイル対策。デーモンの既定 512KB） */
  maxBytes: number;
  /**
   * storeDetails: 自分の指示の 1 行目を TurnEvent.instruction で返す（ADR 0018、D-218。省略は返さない）。
   * 返すのは伏せ字の前の文なので、シンクが伏せ字を通してから保存する
   */
  privacy: { storeTitles: boolean; storeDetails?: boolean };
  /** 本文を受け取れない型のロガー */
  log: MetaOnlyLogger;
  /** 利用者のホーム（Codex のプロジェクト外の作業フォルダを切り落とす。D-135）。省略時は os.homedir() */
  home?: string;
}

export interface ReadStats {
  records: number;
  skipped: number;
  unknownTypes: number;
  missingRequired: number;
}

export interface ReadResult {
  events: NormalizedEvent[];
  next: Cursor;
  stats: ReadStats;
  /** false なら maxBytes で打ち切ったので続きがある */
  done: boolean;
  /** 元ファイルが無い（消えた）。シンクは transcript_missing_at を記録する */
  missing?: boolean;
}

export interface AdapterCapabilities {
  liveStatus: boolean;
  turns: boolean;
  tokens: boolean;
  gitBranch: boolean;
  prLinks: boolean;
  hooks: boolean;
}

export interface AdapterTiming {
  /** 最終ターンが未完了でも、この時間更新が無ければ running とみなさない（Claude 5分、Codex 10分） */
  runningStaleMs: number;
}

/**
 * hooks を持つツールのアダプタだけが実装する。hook-spool アダプタ（正規化）が使う。events / allowlist は
 * src/hook-allowlist.ts の定数から作る（turnlane hook はアダプタではなくその定数を直接 import する。ADR 0009）。
 */
export interface HookSpec {
  events: readonly string[];
  /** イベント名 → spool に残すキー */
  allowlist: Record<string, readonly string[]>;
  normalize(
    extracted: Record<string, unknown>,
    at: number,
  ): Omit<HookEvent, "spool" | "configRoot" | "term"> | null;
}

export interface SessionRef {
  tool: ToolId;
  externalId: string;
}

export type EndedWith = "end_turn" | "question" | "permission" | "error" | "aborted";
export type TurnStatus = "running" | "completed" | "interrupted" | "error";
export type Initiator = "human" | "queued" | "scheduled" | "system";

export interface SessionSeenEvent {
  kind: "session_seen";
  ref: SessionRef;
  /** 活動の時刻。シンクは started_at = min、last_activity_at = max で反映する（冪等） */
  at: number;
  /** セッションの開始時刻（分かれば）。シンクは min で反映する */
  startedAt?: number;
  cwd?: string;
  parent?: SessionRef;
  isSubagent?: boolean;
  entrypoint?: string;
  clientVersion?: string;
  model?: string;
  /**
   * ツール生成の題名。null は「題名を消す」（先頭からの読み直しで、題名の行が空同然のものだけだったとき。ai-session-ingestion 4.4）
   */
  title?: string | null;
  titleSource?: string | null;
  archived?: boolean;
  hasHumanInput?: boolean;
  filePath?: string;
  noise?: boolean;
  /**
   * セッションが終わった時刻（サブエージェントのトランスクリプトが最後の応答（end_turn）で終わったとき）。null は
   * 「終わった後にまた活動があった（終わっていない）」。省略はシンクが触らない。追加の任意項目なので ADAPTER_API_VERSION は上げない
   */
  endedAt?: number | null;
  /** 報告（adapters/report。ADR 0021）のプロジェクトの名前。追加の任意項目 */
  project?: string;
  /** 報告の開く先（http(s) かアプリの URL スキーム。ADR 0021）。追加の任意項目 */
  openUrl?: string;
}

/** 報告の待ちの中身（ADR 0021。ReadContext.privacy.storeDetails のときだけ。伏せ字の前の文。上限は report.ts） */
export interface ReportWait {
  kind: "question" | "permission";
  text: string;
  options?: string[];
  label?: string;
}

export interface TurnEvent {
  kind: "turn";
  ref: SessionRef;
  turnKey: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TurnStatus;
  endedWith?: EndedWith;
  initiator?: Initiator;
  gitBranch?: string;
  cwd?: string;
  tokens?: { input: number; output: number; cacheRead?: number };
  toolCounts?: Record<string, number>;
  editedFiles?: number;
  pendingQuestion?: boolean;
  /** 締めの決まり文句の質問で終わった（3.3.1）。追加の任意項目なので ADAPTER_API_VERSION は上げない */
  closingQuestion?: boolean;
  /** ターン内の最後のレコードの時刻（running の鮮度の判定に使う） */
  lastActivityAt?: number;
  /**
   * ターンを始めた自分の指示の 1 行目（件名に使える指示だけ。120 文字まで。ReadContext.privacy.storeDetails のときだけ。
   * 伏せ字の前の文。carry には残さず、指示の行を読んだチャンクのイベントにだけ付く。ADR 0018）
   */
  instruction?: string;
  /**
   * そのセッションの、このターンより前に始まった開いたターンを閉じる（報告で新しいターンを始めたとき。ADR 0021）。
   * 追加の任意項目
   */
  closeOpen?: boolean;
  /** 報告の待ちの中身（ADR 0021）。追加の任意項目 */
  reportWait?: ReportWait;
}

export interface ArtifactEvent {
  kind: "artifact";
  ref: SessionRef;
  turnKey?: string;
  at: number;
  artifact:
    | { kind: "pr"; repo: string; number: number; url?: string }
    | { kind: "commit"; sha: string };
}

export interface LiveStatusEvent {
  kind: "live_status";
  ref: SessionRef;
  at: number;
  status: "busy" | "idle" | "gone";
  pid?: number;
}

/** 利用枠の 1 つの枠（使用率 0〜100 と、明ける時刻 ms） */
export interface ClaudeLimitWindowFact {
  pct: number;
  resetsAt: number;
}

/**
 * Claude Code が設定ディレクトリの `.claude.json` にキャッシュした利用枠（cachedUsageUtilization）の、5 時間・7 日の枠の
 * 使用率と明ける時刻だけ。ほかのキー（アカウントの情報など）は読まない。live probe が `.claude.json` の更新を見つけたときに出す
 */
export interface ClaudeLimitsEvent {
  kind: "claude_limits";
  /** 設定ディレクトリ（ルートのパス。hook の config_root と同じ書き方） */
  account: string;
  /** Claude Code が値を取得した時刻（fetchedAtMs） */
  fetchedAt: number;
  fiveHour?: ClaudeLimitWindowFact;
  sevenDay?: ClaudeLimitWindowFact;
}

export interface HookEvent {
  kind: "hook";
  /** hook_spool は自分のセッションを持たず、元ツールの ToolId を入れる */
  ref: SessionRef;
  at: number;
  name: string;
  notificationType?: string;
  toolName?: string;
  errorType?: string;
  turnId?: string;
  promptId?: string;
  source?: string;
  reason?: string;
  cwd?: string;
  /**
   * サブエージェントの中で出た hook のサブエージェントの ID（Claude Code の agent_id。ref は親のセッション）。
   * トランスクリプトの `subagents/agent-<id>.jsonl` の <id>。追加の任意項目
   */
  agentId?: string;
  /** サブエージェントの種類（Claude Code の agent_type。種類の名前だけ）。追加の任意項目 */
  agentType?: string;
  /** 権限のモード（permission_mode。bypassPermissions の許可の hook は自動で許可されるので待ちにしない）。追加の任意項目 */
  permissionMode?: string;
  /** hook を受けた設定ディレクトリ（turnlane hook が環境変数から取る。S5）。追加の任意項目 */
  configRoot?: string;
  /**
   * 利用枠の自動再開を止めた通知（quota_auto_resume_disabled）が「明けるのが 24 時間より先」の定型文だった（週の上限など）。
   * 文は持たず真偽値だけ（turnlane hook が spool の quota_horizon に残す）。追加の任意項目
   */
  horizon?: boolean;
  /**
   * Orca の端末のハンドル（turnlane hook が環境変数 ORCA_TERMINAL_HANDLE から取る。D-238）。Turnlane から答えるときに、
   * Orca のどの端末に送るかを決める。形が合うものだけ（不透明な ID。会話の中身ではない）
   */
  term?: string;
  spool: { file: string; offset: number };
}

/** すべて「累積値」を運ぶ。シンクは代入のみ（加算しない）→ 再読込しても同じ結果 */
export type NormalizedEvent =
  | SessionSeenEvent
  | TurnEvent
  | ArtifactEvent
  | LiveStatusEvent
  | HookEvent
  | ClaudeLimitsEvent;

export type LiveProbe = LiveStatusEvent | ClaudeLimitsEvent;

export interface DetectEnv {
  home: string;
  vars: Record<string, string | undefined>;
  /**
   * 利用者が手で足した設定ディレクトリ（絶対パス。オンボーディングの Choose a folder…）。アダプタは自分の形
   * （Claude Code なら projects/ がある）に合うものだけを候補に足す。省略可
   */
  extraRoots?: readonly string[];
}

export interface SourceAdapter {
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  readonly tool: ToolId;
  /** UI の表示名（'Claude Code' 等） */
  readonly displayName: string;
  readonly parserId: string;
  /** 上げるとカーソルの carry を破棄して読み直す */
  readonly parserVersion: number;
  /** semver 範囲。外れたら UI に注意を出す（縮退はしない） */
  readonly testedVersions: string;
  readonly capabilities: AdapterCapabilities;
  readonly timing: AdapterTiming;
  /** レコード型 → 読むキー（監査・テストで使う）。'*' は型を問わない共通のキー */
  readonly allowlist: Record<string, readonly string[]>;
  readonly hooks?: HookSpec;

  detect(env: DetectEnv): Promise<DetectedRoot[]>;
  watch(root: DetectedRoot): WatchSpec[];
  listStreams(root: DetectedRoot, opts: { sinceMs?: number }): Promise<StreamSpec[]>;
  streamFor(root: DetectedRoot, absPath: string): StreamSpec | null;
  read(stream: StreamSpec, cursor: Cursor | null, ctx: ReadContext): Promise<ReadResult>;
  /** Claude: sessions/<pid>.json + pid 生存確認、`.claude.json` の利用枠（更新されたときだけ） */
  probeLive?(root: DetectedRoot): Promise<LiveProbe[]>;
}
