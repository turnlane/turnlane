/**
 * 拡張点（デーモン側。ADR 0015）。拡張はビルドのときに組み込む（scripts/build.ts --ext <dir>）。公開のビルドでは一覧が空。
 *
 * 拡張のモジュールは、`DaemonExtHost` を受け取って `DaemonExtension` を返す関数を default export する。実行時に import して
 * よいのは型だけ（`import type`）で、zod などの実体は host から受け取る（拡張のリポジトリの依存とデーモンの依存を分けるため）。
 *
 * 拡張点の名前は機能に寄せず一般的にする（launcher・presence・calendar・notify・review・ai・power）。
 * 本体は「拡張が使えるか」を判定しない。判定が要るなら拡張の中で行う
 */
import type { Database } from "bun:sqlite";
import type { MetaOnlyLogger } from "@turnlane/collectors";
import type { Clock, ExtMigration, FolderTrust, MutateCtx, TurnlaneSettings } from "@turnlane/core";
import type {
  AiLaunchInput,
  AiLaunchOptions,
  AiLaunchResult,
  AiLaunchTool,
  ClaudeLimits,
  CreateTaskInput,
  Interval,
  QueueItem,
  TaskView,
  TimeBlockView,
  WorkCheckView,
  WorkDiffView,
  WorktreeCleanupResult,
} from "@turnlane/core/api";
import type { SummaryFailure } from "@turnlane/core/report";
import type { Hono } from "hono";
import type { z } from "zod";
import type { AiLaunchTrigger } from "../launch/service.ts";
import type { PowerState } from "./power.ts";

/** 拡張点の版（本体の core に置き、Web と共有する） */
export { EXT_API_VERSION } from "@turnlane/core";
export type { PowerState } from "./power.ts";

/** 拡張が受け取る実体（実行時の依存を host から渡す） */
export interface DaemonExtHost {
  apiVersion: number;
  z: typeof z;
}

export interface ExtStarted {
  stop(): void | Promise<void>;
}

export interface DaemonExtension {
  /** 小文字の英数字（2〜24文字）。設定のキー `ext.<id>.`、テーブル `ext_<id>_`、ルート `/api/ext/<id>/` に使う */
  id: string;
  apiVersion: number;
  /** 設定のキー（`ext.<id>.<名前>` の完全な名前 → 値の型）。turnlane config と /api/config で本体のキーと同じに扱う */
  configSchemas?: Record<string, z.ZodType>;
  /** 拡張のテーブル（`ext_<id>_` の接頭辞）。本体の連番とは別に、並びの順に1回だけ適用する */
  migrations?: ExtMigration[];
  /** `/api/ext/<id>/*` の下のルート。認証（Bearer・クッキー）は本体の /api と同じものを先に通す */
  routes?: (app: Hono, deps: ExtDeps) => void;
  /** デーモンの起動の最後に呼ぶ（タイマー等）。stop はデーモンの停止のときに呼ぶ */
  start?: (deps: ExtDeps) => ExtStarted | undefined;
}

/** 拡張のモジュールの default export */
export type DaemonExtensionFactory = (host: DaemonExtHost) => DaemonExtension;

/**
 * AI の1回の実行の結果。schema を渡し、CLI が構造化の出力に対応していれば json に検証済みの値（CLI が schema で検証したもの）。
 * 対応していない版では json は無く、text に応答の文がそのまま入る（呼び出し側が読み取る）
 */
export type OneShotResult =
  | { ok: true; text: string; json?: unknown }
  | { ok: false; failure: SummaryFailure };

/**
 * 人のいないときの起動（`launcher.launch` の `{ unattended: true }`）で、端末を開かなかったとき。何も作らない（worktree・起動の行）
 * - screen_locked: 画面がロックされていた（ロックが外れてからもう一度呼ぶ）
 * - not_opened: 端末を開けなかった（コピーには落とさない。起動の行は failed）
 */
export interface LaunchDeferred {
  outcome: "locked";
  reason: "screen_locked" | "not_opened";
}

/** 時刻付きの予定の事実（題名・場所・参加者は渡さない） */
export interface ExtCalendarEvent {
  id: string;
  start: number;
  end: number;
  /** 会議（参加者か会議リンクがある。集中モードの対象と同じ判定） */
  meeting: boolean;
}

/** ExtDeps.tasks.update で変えられるもの */
export interface ExtTaskPatch {
  title?: string;
  notes?: string | null;
  estimateMin?: number | null;
  /** 置く日（論理日）。null は Inbox */
  date?: string | null;
}

/** 本体が拡張に渡す部品 */
export interface ExtDeps {
  id: string;
  /** DB。拡張が書いてよいのは自分のテーブル（ext_<id>_）と自分の設定だけ。本体のテーブルは読むだけにする */
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  logger: MetaOnlyLogger;
  /** 拡張用のディレクトリ（`<データ>/ext/<id>`。0700 で作る） */
  dataDir: string;
  settings: {
    /** 設定の値（本体・拡張のどちらのキーも読める） */
    get<T = unknown>(key: string): T | undefined;
    /** 拡張のキー（`ext.<id>.*`）だけ書ける。値は configSchemas で検証する */
    set(key: string, value: unknown): unknown;
    /** 本体の設定（タイムゾーン・日付の区切り・稼働曜日など） */
    core(): TurnlaneSettings;
  };
  events: {
    /** Web に知らせる（SSE の `ext` イベント。Web は `["ext", id]` のキャッシュを取り直す）。データは載せない */
    publish(): void;
    /** 本体の SSE の種類（task・work_item・follow_up・calendar・settings・day_boundary など）を購読する */
    subscribe(l: (type: string) => void): () => void;
  };
  tasks: {
    /** add_task と同じ（source と externalId で冪等） */
    /** 同じ source・externalId のタスクを消していたら null（作り直さない） */
    create(input: CreateTaskInput): TaskView | null;
    get(id: string): TaskView | null;
    byExternal(source: string, externalId: string): TaskView | null;
    complete(id: string): void;
    /**
     * 完了を取り消す（画面の「元に戻す」と同じ。未完了に戻す）。followUps は完了で一緒に閉じた自分の番（開き直す）。
     * 完了していない・無い・消したタスクは null（完了していないタスクは何も変えずにそのまま返す）
     */
    reopen(id: string, o?: { followUps?: readonly string[] }): TaskView | null;
    /**
     * 題名・メモ・見積（分）・日付（null は Inbox）を変える（画面の編集と同じ）。渡したものだけ変える。
     * 無いタスク・消したタスクは null
     */
    update(id: string, patch: ExtTaskPatch): TaskView | null;
    /** タスクを消す（画面の削除と同じ。時間ブロックは残り、タスクと一緒に表示から消える）。無ければ何もしない */
    remove(id: string): void;
    /** タスクの時間ブロック（開始の順）。無いタスクは空 */
    blocks(id: string): TimeBlockView[];
  };
  /** 時間ブロック（Turnlane の中だけ。カレンダーには書かない。画面で時間に置くのと同じ） */
  timeBlocks: {
    /** タスクの時間ブロックを作る。無いタスクは例外 */
    create(b: { taskId: string; startAt: number; endAt: number }): TimeBlockView;
    /** 開始・終わりを変える。無いブロックは null */
    update(id: string, p: { startAt?: number; endAt?: number }): TimeBlockView | null;
    /** 外す。無ければ何もしない */
    remove(id: string): void;
  };
  /** 自分の番の一覧（画面と同じ） */
  queue(): QueueItem[];
  /** タスクから AI に頼む（ADR 0014）。デーモンが起動の部品を持たないとき（テスト等）は available() が false */
  launcher: {
    available(): boolean;
    options(taskId: string | null): Promise<AiLaunchOptions>;
    launch(input: AiLaunchInput, trigger: AiLaunchTrigger): Promise<AiLaunchResult>;
    /**
     * 人のいないときの起動。画面がロックされていれば何もせず `locked` を返す（ロック中に開ける端末では待たずに起動する。
     * waitsWhileLocked）。Orca は前面に出さずに開き、端末を開けなければコピーに落とさず `locked`（not_opened）を返す。
     * 呼び出し側は、ロックが外れてからもう一度呼べる
     */
    launch(
      input: AiLaunchInput,
      trigger: AiLaunchTrigger,
      o: { unattended: true },
    ): Promise<AiLaunchResult | LaunchDeferred>;
    /**
     * 人のいないときの起動が、画面のロック中に待つか（いまの端末の設定で決まる。Orca は待たない）。説明の文言を変えるのに使う。
     * 起動の部品が無いときは true
     */
    waitsWhileLocked(): boolean;
    /**
     * Claude Code がそのアカウントでフォルダを信頼しているか（設定のファイルの `projects[<パス>].hasTrustDialogAccepted` だけを
     * 読む。worktree は元のリポジトリ、git の中はリポジトリのルートまでの親も見る）。信頼していないと、対話モードの claude は
     * 「このフォルダを信頼しますか」で止まり、人のいないときの起動はセッションにならない。claudeAccount を省くと起動と同じ既定。
     * Codex・読めない・起動の部品が無いときは unknown
     */
    folderTrust(o: {
      repo: string;
      tool?: AiLaunchTool;
      claudeAccount?: string | null;
      taskId?: string | null;
    }): FolderTrust;
    /**
     * フォルダの信頼のために、いつもの端末でそのフォルダの claude を開く（前面に出す。信頼は人が選ぶ。本体は設定のファイルに
     * 書かない）。開けなければコマンドをコピーする
     */
    openForTrust(o: { repo: string; claudeAccount?: string | null }): Promise<{
      outcome: "opened" | "opened_copied" | "copied";
      app: string | null;
      command: string | null;
    }>;
    /**
     * 依頼の worktree と手元のブランチを捨てる（AI 詳細パネルの「worktree を消す」を確認の後に押したのと同じ。未コミットの
     * 変更・取り込まれていないコミットも消える）。タスク・PR・リモートのブランチには触らない。確認は呼び出し側の画面が出す。
     * worktree の無い依頼は removed: false（missing）
     */
    discard(launchId: string): Promise<WorktreeCleanupResult>;
  };
  /** 在席（ADR 0013） */
  presence: {
    spans(from: number, to: number): Interval[];
    /** 最後に Mac を使っていた時刻（在席の区間の終わり。記録が無ければ null） */
    lastActiveAt(): number | null;
  };
  calendar: {
    /** busy な時刻付きの予定（和集合） */
    busy(from: number, to: number): Interval[];
    /**
     * その日の空き枠（デイビューと同じ: 計画の目安の窓から busy な予定と時間ブロックを引いた区間。15分単位、今日は今より後。
     * 稼働日でない日は空）
     */
    freeSlots(date: string): Interval[];
    /** 稼働日か（設定の稼働曜日と、祝日のカレンダーの祝日） */
    isWorkday(date: string): boolean;
    /** busy な時刻付きの予定（終日・取り消し・自分の時間ブロックは除く）。開始の順 */
    events(from: number, to: number): ExtCalendarEvent[];
  };
  notify: {
    /**
     * 通知を止める条件を足す（閉店モード・集中モードの後に当てる）。止めたものは onHeld に渡す。返した関数で外す
     */
    hold(filter: (item: QueueItem) => boolean, onHeld?: (items: QueueItem[]) => void): () => void;
  };
  /** 確認支援（ADR 0014 の 7） */
  review: {
    check(launchId: string): Promise<WorkCheckView>;
    runTests(launchId: string): void;
    /**
     * 差分の中身: ファイルごとの追加・削除と、上限つきの抜粋（unified・前後2行）。範囲は check の差分と同じ。
     * maxFiles（既定 30・最大 200）・maxBytes（抜粋の上限。既定 12000・最大 64000）。git でない・分からなければ null
     */
    diff(
      launchId: string,
      o?: { maxFiles?: number; maxBytes?: number },
    ): Promise<WorkDiffView | null>;
  };
  /** 利用者の claude / codex の CLI を1回だけ動かす（日報の要約と同じ起動の仕方。ツールなし・セッションを保存しない） */
  ai: {
    runOneShot(o: {
      tool: "claude_code" | "codex";
      input: string;
      timeoutMs?: number;
      /**
       * 応答の形（JSON Schema）。Claude は `--output-format json --json-schema`、Codex は `--output-schema` で渡し、
       * 結果の json に入る。CLI の版が対応していなければ渡さずに文で返す（json なし）
       */
      schema?: Record<string, unknown>;
      /**
       * Claude のアカウント（設定ディレクトリの絶対パス）。`~/.claude` 以外は CLAUDE_CONFIG_DIR を付け、`~/.claude` なら
       * 消す。省略すると今までどおりデーモンの環境のまま。Codex では使わない
       */
      claudeAccount?: string | null;
    }): Promise<OneShotResult>;
  };
  power: {
    /** システムのアイドルスリープを止める（ディスプレイは止めない）。返した関数で外す */
    keepAwake(reason: string): () => void;
    /**
     * 電源とふたの状態を読む（`pmset -g batt` と `ioreg -r -k AppleClamshellState`。root 不要・読むだけ）。読めない値は null。
     * 変化の購読は無い（必要なときに呼ぶ）
     */
    state(): Promise<PowerState>;
  };
  /** 利用枠 */
  limits: {
    /**
     * Claude の利用枠の最新の値（本体が起動した Claude のセッションの statusLine が送ったもの）。account は設定ディレクトリの
     * 絶対パス（省略すると `~/.claude`）。届いていない（Pro・Max の契約でない・まだ応答が無い・受け口が使われていない）、
     * またはどの枠もリセットの時刻を過ぎていれば null
     */
    claude(account?: string): ClaudeLimits | null;
  };
}
