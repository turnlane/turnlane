/** AI の画面（GET /api/ai/live。m2-api 33章、ux-mvp 4.19）の型 */
import type { OpenWaitBrief } from "./answer.ts";
import type { AiItemSummary } from "./board.ts";
import type { EpochMs, ReadMeta } from "./common.ts";

/**
 * AI のプロセス: alive = Claude Code のプロセスが動いている（sessions/<pid>.json の確かめが新しい）/ gone = 終わった /
 * unknown = プロセスの有無が分からない（Codex・Claude Desktop）
 */
export type LiveProcess = "alive" | "gone" | "unknown";

/** 片付けが残っている起動（Turnlane から AI に頼んだもの。worktree が残っているか、turnlane ai run が終わっていない） */
export interface LiveLaunch {
  launchId: string;
  taskId: string;
  /** 頼んだタスクが完了している（片付けずに完了で済ませた後の起動） */
  taskDone: boolean;
  /** AI のプロセス（turnlane ai run）がまだ動いている */
  aiRunning: boolean;
  /**
   * 残っている worktree（完了のシートと同じ判定。clean = そのまま消せる / unmerged = 取り込まれていない /
   * dirty = 未コミットの変更がある）。無ければ null
   */
  worktree: { path: string; branch: string | null; state: "clean" | "unmerged" | "dirty" } | null;
}

/** 生きている AI 項目 1 件（リポジトリ × ブランチ。ボードのカードと同じ単位） */
export interface LiveItem
  extends Pick<
    AiItemSummary,
    | "id"
    | "title"
    | "titleSource"
    | "status"
    | "reason"
    | "estimated"
    | "sources"
    | "repoRoot"
    | "scratch"
    | "branch"
    | "prRef"
  > {
  /** title が利用者の付けた名前 */
  userTitled?: boolean;
  lastActivityAt: EpochMs;
  /** 今のひと続きの作業の始まり（running のとき。間が 30 分未満のターンをつなぐ）。running でなければ null */
  runStartedAt: EpochMs | null;
  process: LiveProcess;
  /** 生きているセッションの数（Claude Code のプロセスが動いているもの。2 以上で「2 セッション」） */
  liveSessions: number;
  /** 今も動いているサブエージェントの数（最後の活動から 5 分以内） */
  subagentsRunning: number;
  /** 片付けが残っている起動（無ければ null） */
  launch: LiveLaunch | null;
  /** 答える対象の待ち（queue の item と同じ判定。無ければ省く） */
  wait?: OpenWaitBrief;
  /**
   * 上限待ち（status done・reason rate_limit で、まだ明けていない）。止まった時刻と明ける時刻。untilKnown が false なら
   * until は見込み。無ければ省く
   */
  limitWait?: { since: EpochMs; until: EpochMs; untilKnown: boolean };
}

/**
 * GET /api/ai/live: 生きている AI 項目の候補。running・プロセスが生きている・プロセスが分からず最後の動きから 6 時間以内・
 * 片付けが残っている のどれかに当たるもの（隠した項目は除く）。自分の番・後で（GET /api/queue）にある項目でも当たれば
 * 返す（画面が core の liveSections で 1 か所に振り分ける）。最後の動きの新しい順
 */
export interface AiLiveResponse extends ReadMeta {
  items: LiveItem[];
}
