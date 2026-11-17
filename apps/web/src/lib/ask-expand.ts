/**
 * 図つきの問い（ADR 0022。ux-mvp 4.23）の「広げる」の状態。パネルの節と広げた画面（components/AskOverlay.tsx）が同じものを読む:
 *
 * - 下書き（選んだ案・メモ・返している途中）: 問いごとに web のメモリにだけ持つ。広げても戻しても消えない。返したらメモを空にする
 * - 広げた画面: `full`（問いの全体）と `figure`（案の図 1 枚を大きく）。案の図は全体の中からもパネルからも開ける。
 *   Esc は 1 段ずつ戻る（図 → 全体 → 閉じる）。開いた部品（opener）を段ごとに覚え、戻ったらそこへフォーカスを返す
 *   （返すのは広げた画面が描き直した後。takeAskFocus）
 * - キー: 1〜4 で選ぶ・⌘⏎ で返す・f で広げる（入力欄の外。f はパネルの節だけ）。判定は純粋関数（askKeyAction）
 *
 * 中身（問い・案・図）はここに持たない（useAsk のキャッシュ。閉じたら捨てる）。メモは利用者の書いた文で、Mac の外へは出さない。
 */
import { useSyncExternalStore } from "react";
import { type AskOutcome, sendAsk } from "../data/ask.ts";

// ---------- 下書き ----------

export interface AskDraft {
  choice: string | null;
  note: string;
  busy: boolean;
}

const EMPTY: AskDraft = { choice: null, note: "", busy: false };
const drafts = new Map<string, AskDraft>();
const draftListeners = new Set<() => void>();

export function getAskDraft(id: string): AskDraft {
  return drafts.get(id) ?? EMPTY;
}

export function setAskDraft(id: string, patch: Partial<AskDraft>): void {
  drafts.set(id, { ...getAskDraft(id), ...patch });
  for (const f of draftListeners) f();
}

/** 問いが閉じたら下書きを捨てる */
export function dropAskDraft(id: string): void {
  if (!drafts.delete(id)) return;
  for (const f of draftListeners) f();
}

export function useAskDraft(id: string): AskDraft {
  return useSyncExternalStore(
    (f) => {
      draftListeners.add(f);
      return () => draftListeners.delete(f);
    },
    () => getAskDraft(id),
    () => getAskDraft(id),
  );
}

/** 選んだ案をもう一度押すと外す */
export function toggleAskChoice(id: string, label: string): void {
  setAskDraft(id, { choice: getAskDraft(id).choice === label ? null : label });
}

/** 返せるか（返している途中でなく、案かメモがある） */
export function canSendAsk(d: AskDraft): boolean {
  return !d.busy && (d.choice !== null || d.note.trim().length > 0);
}

/**
 * 下書きを AI に返す（パネルと広げた画面のどちらからでも同じ 1 回）。返せたらメモを空にし、広げた画面を閉じる。
 * 返せなければ null（何もしない）
 */
export async function sendAskDraft(
  id: string,
  workItemId: string | null,
  send: typeof sendAsk = sendAsk,
): Promise<AskOutcome | null> {
  const d = getAskDraft(id);
  if (!canSendAsk(d)) return null;
  setAskDraft(id, { busy: true });
  const r = await send(id, workItemId, {
    ...(d.choice !== null ? { choice: d.choice } : {}),
    ...(d.note.trim() ? { note: d.note } : {}),
  });
  setAskDraft(id, r.ok ? { busy: false, note: "" } : { busy: false });
  if (r.ok && overlay?.askId === id) closeAskOverlay();
  return r;
}

// ---------- 広げた画面 ----------

export interface AskOverlayState {
  askId: string;
  workItemId: string | null;
  /** 問いの全体を広げている */
  full: boolean;
  /** 大きくしている案の図（案の番号）。null なら全体 */
  figure: number | null;
}

export type AskOverlayAction =
  | { kind: "expand"; askId: string; workItemId: string | null }
  | { kind: "figure"; askId: string; workItemId: string | null; n: number }
  | { kind: "back" }
  | { kind: "close" };

/** 広げた画面の遷移（純粋関数）。back は Esc: 図 → 全体（全体から開いたとき）→ 閉じる */
export function askOverlayReduce(
  s: AskOverlayState | null,
  a: AskOverlayAction,
): AskOverlayState | null {
  switch (a.kind) {
    case "expand":
      return { askId: a.askId, workItemId: a.workItemId, full: true, figure: null };
    case "figure":
      // 全体の中から開いたら Esc で全体に戻る。パネルから開いたら Esc で閉じる
      return {
        askId: a.askId,
        workItemId: a.workItemId,
        full: s?.askId === a.askId && s.full,
        figure: a.n,
      };
    case "back":
      if (!s) return null;
      if (s.figure !== null && s.full) return { ...s, figure: null };
      return null;
    case "close":
      return null;
  }
}

let overlay: AskOverlayState | null = null;
/** 段ごとの開いた部品（戻ったらそこへフォーカスを返す） */
const openers: (HTMLElement | null)[] = [];
const overlayListeners = new Set<() => void>();

function setOverlay(next: AskOverlayState | null): void {
  overlay = next;
  for (const f of overlayListeners) f();
}

export function getAskOverlay(): AskOverlayState | null {
  return overlay;
}

export function subscribeAskOverlay(f: () => void): () => void {
  overlayListeners.add(f);
  return () => overlayListeners.delete(f);
}

export function useAskOverlay(): AskOverlayState | null {
  return useSyncExternalStore(subscribeAskOverlay, getAskOverlay, getAskOverlay);
}

/**
 * 戻ったときにフォーカスを返す部品。返すのは広げた画面（AskOverlay）が描き直した後: 段が変わったら（図 → 全体）その効果の中で、
 * 閉じたら背景の inert を外した後で（takeAskFocus）
 */
let pendingFocus: HTMLElement | null = null;

/** 返す先を受け取る（1 回だけ） */
export function takeAskFocus(): HTMLElement | null {
  const el = pendingFocus;
  pendingFocus = null;
  return el;
}

/** 返す先へフォーカスを置く（画面から消えていれば置かない）。置いたら true */
export function focusBack(el: HTMLElement | null): boolean {
  if (!el?.isConnected) return false;
  el.focus({ preventScroll: true });
  return true;
}

/** 問いの全体を広げる（opener は Esc で戻ったときにフォーカスを返す部品） */
export function openAskOverlay(
  askId: string,
  workItemId: string | null,
  opener: HTMLElement | null,
): void {
  openers.length = 0;
  openers.push(opener);
  setOverlay(askOverlayReduce(overlay, { kind: "expand", askId, workItemId }));
}

/** 案の図を 1 枚だけ大きくする（パネルからでも全体の中からでも） */
export function openAskFigure(
  askId: string,
  workItemId: string | null,
  n: number,
  opener: HTMLElement | null,
): void {
  const next = askOverlayReduce(overlay, { kind: "figure", askId, workItemId, n });
  if (!next?.full) openers.length = 0;
  openers.push(opener);
  setOverlay(next);
}

/** Esc・閉じるボタン: 1 段戻り、その段を開いた部品へフォーカスを返す */
export function backAskOverlay(): void {
  const next = askOverlayReduce(overlay, { kind: "back" });
  pendingFocus = openers.pop() ?? null;
  if (!next) openers.length = 0;
  setOverlay(next);
}

/** すべて閉じる（返した後）。最初に開いた部品へフォーカスを返す */
export function closeAskOverlay(): void {
  pendingFocus = openers[0] ?? null;
  openers.length = 0;
  setOverlay(null);
}

// ---------- キー ----------

export type AskKeyAction =
  | { kind: "choose"; n: number }
  | { kind: "send" }
  | { kind: "expand" }
  | { kind: "back" }
  | null;

export interface AskKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** 文字を入れる欄の中 */
  inText: boolean;
}

/**
 * 押したキー → 問いの操作（純粋関数）。where は panel（パネルの節。f で広げる）・full（広げた全体。Esc で戻る）・
 * figure（図 1 枚。Esc だけ）。options は案の数
 */
export function askKeyAction(
  e: AskKeyInput,
  where: "panel" | "full" | "figure",
  options: number,
): AskKeyAction {
  if (where !== "panel" && e.key === "Escape") return { kind: "back" };
  if (where === "figure") return null;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return { kind: "send" };
  if (e.metaKey || e.ctrlKey || e.altKey || e.inText) return null;
  if (where === "panel" && e.key === "f") return { kind: "expand" };
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= options) return { kind: "choose", n };
  return null;
}

/** フォーカスの罠: Tab で次（⇧ で前）へ。枠の外にいれば最初（⇧ なら最後）。count が 0 なら -1 */
export function trapIndex(count: number, current: number, shift: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return (current + (shift ? -1 : 1) + count) % count;
}

/** テスト用: 状態を空にする */
export function resetAskExpandForTest(): void {
  drafts.clear();
  openers.length = 0;
  overlay = null;
  pendingFocus = null;
}
