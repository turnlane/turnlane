/**
 * 画面の状態（サイドバー、詳細パネル、トースト、ショートカット一覧）。サーバーのデータは TanStack Query に置き、
 * ここには置かない。小さいので useSyncExternalStore で足りる。
 */
import type { QueueItem, TaskView } from "@turnlane/core/web";
import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

/** 開いている詳細パネル（AI・タスク・予定のどれか1つ。D-070） */
export function anyPanelOpen(
  s: Pick<UiState, "panelWorkItemId" | "panelTaskId" | "panelEventId">,
): boolean {
  return s.panelWorkItemId !== null || s.panelTaskId !== null || s.panelEventId !== null;
}

/** 画面で選んでいる項目（⌘K の Selected と `p`。ux-mvp 6.1）。各画面が選択の変化で書く */
export type SelItem =
  | { kind: "task"; task: TaskView }
  | { kind: "turn"; item: QueueItem }
  | { kind: "ai"; id: string; title: string | null };

/** ⌘K のパレット。mode: root（検索とコマンド）/ place（時間に置く。`p`）/ new（新規タスクの入力） */
export type PaletteMode = "root" | "place" | "new";

export type BoardMode = "three" | "week";

const BOARD_MODE_KEY = "turnlane.board.mode";

function readBoardMode(): BoardMode {
  try {
    return globalThis.localStorage?.getItem(BOARD_MODE_KEY) === "week" ? "week" : "three";
  } catch {
    return "three";
  }
}

/** ボードの表示を切り替えて、ブラウザに覚える（D-074） */
export function setBoardMode(mode: BoardMode): void {
  setUi({ boardMode: mode });
  try {
    globalThis.localStorage?.setItem(BOARD_MODE_KEY, mode);
  } catch {
    // 保存できなくても切り替えはできる
  }
}

export interface UiState {
  sidebarCollapsed: boolean;
  /** AI 詳細パネル（右からスライド）に出している AI 項目 */
  panelWorkItemId: string | null;
  /**
   * 「答える」の節を開いている AI 項目（D-238。行の「答える」・`a` で開く）。詳細パネル（ボード）・自分の番の画面の詳細が
   * その項目を出している間だけ節を開く。別の項目を出したら閉じる
   */
  answerFor: string | null;
  /** タスクの詳細パネル（D-070）。パネルは同時に1つだけ（setUi が他を閉じる） */
  panelTaskId: string | null;
  /** 予定の詳細パネル（D-070。読み取り専用） */
  panelEventId: string | null;
  /** 記録のパネル（デイビューの右。D-192）。詳細パネルと同じ場所に排他で開く（どれかを開いたら閉じる） */
  recordOpen: boolean;
  helpOpen: boolean;
  /** ⌘K のパレット（M2-15）。閉じているときは null */
  palette: PaletteMode | null;
  /** 画面で選んでいる項目（⌘K の Selected と `p`） */
  selection: SelItem[];
  /** ⌘K の検索結果から移動したとき、移動先の画面で選ぶ項目（`task:<id>`）。画面が読んだら消す */
  focus: { key: string; date: string | null } | null;
  toasts: Toast[];
  /** ボードの基準日（3日ボードの真ん中の列。null は今日に追従） */
  boardAnchor: string | null;
  /** ボードの表示（D-074）: three = 3日ボード（既定）/ week = 週表示（計画モード）。ブラウザに覚える */
  boardMode: BoardMode;
  /** 3日ボードの前・次の稼働日（応答の days から。`[` / `]` と上部の ‹ › の移動先） */
  boardNeighbors: { around: string; prev: string; next: string } | null;
  /** 週表示に出している日付の範囲（上部の見出し `10/1 – 10/7`。D-101 (3)）。週表示を出していなければ null */
  boardRange: { from: string; to: string } | null;
  /** デイビューの日付（null は今日に追従） */
  dayAnchor: string | null;
  /** デーモンの「今日」（論理日付。SSE の hello と読み取り応答から）。儀式と集計の今日 */
  serverToday: string | null;
  /** 表示の「今日」（暦日。D-054）。週ボードの今日の列 */
  serverDisplayToday: string | null;
  /** ボード・デイビュー以外の画面からの新規予定（⌘K・⇧C。D-093）。デイビューが開いたら入力を出して消す */
  newEventRequest: number | null;
  /**
   * いま完了にしたタスク（id → 完了にした端末の時刻）。Inbox はこの間だけ行をその場に残し、過ぎたら「今日閉じた」へ移す
   * （D-139 (4)。LINGER_MS）
   */
  recentDone: Record<string, number>;
}

/** 完了にした Inbox の行をその場に残す長さ */
export const LINGER_MS = 4000;

let state: UiState = {
  sidebarCollapsed: false,
  panelWorkItemId: null,
  answerFor: null,
  panelTaskId: null,
  panelEventId: null,
  recordOpen: false,
  helpOpen: false,
  palette: null,
  selection: [],
  focus: null,
  toasts: [],
  boardAnchor: null,
  boardMode: readBoardMode(),
  boardNeighbors: null,
  boardRange: null,
  dayAnchor: null,
  serverToday: null,
  serverDisplayToday: null,
  newEventRequest: null,
  recentDone: {},
};
const listeners = new Set<() => void>();

export function getUi(): UiState {
  return state;
}

const PANELS = ["panelWorkItemId", "panelTaskId", "panelEventId"] as const;

export function setUi(p: Partial<UiState> | ((s: UiState) => Partial<UiState>)): void {
  const patch = typeof p === "function" ? p(state) : p;
  // 詳細パネルは1つだけ: どれかを開いたら他を閉じる。記録のパネル（D-192）も同じ場所なので排他
  const opened = PANELS.find((k) => patch[k] != null);
  const others: Partial<UiState> = opened
    ? {
        ...Object.fromEntries(PANELS.filter((k) => k !== opened).map((k) => [k, null])),
        recordOpen: false,
      }
    : patch.recordOpen === true
      ? { panelWorkItemId: null, panelTaskId: null, panelEventId: null }
      : {};
  state = { ...state, ...others, ...patch };
  for (const l of listeners) l();
}

export function useUi<T>(sel: (s: UiState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
  );
}

let toastSeq = 0;
export function toast(text: string, action?: Toast["action"], ms = 5000): void {
  const id = ++toastSeq;
  setUi((s) => ({ toasts: [...s.toasts, { id, text, ...(action ? { action } : {}) }] }));
  setTimeout(() => setUi((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function dismissToast(id: number): void {
  setUi((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
