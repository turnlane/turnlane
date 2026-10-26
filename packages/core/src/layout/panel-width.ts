/**
 * 右の詳細パネル（AI・タスク・予定・自分の番の詳細）の幅（ux-mvp 4.12.1）。左の縁をドラッグして変え、設定 `ui.panel_width` に
 * この Mac で1つだけ保存する（全画面・全種類のパネルで共通）。純粋関数にしてテストする。
 *
 * - 既定は 380px（確定デザインの幅。ドラッグしない人の見た目は変えない）
 * - 最小は 320px（題名・ボタンの行・属性の行が英語・日本語とも崩れない幅。AI の各状態・タスク・予定・自分の番の詳細で確かめた）
 * - 最大は「パネルの左の領域（ボード・日ビュー・一覧）を PANEL_MAIN_MIN 以上残す」幅。窓の幅が変わればその場で当て直す。
 *   ただし既定の幅より狭くはしない（狭い窓でも、ドラッグしない人のパネルは今までどおり 380px）
 */

export const PANEL_WIDTH_DEFAULT = 380;
export const PANEL_WIDTH_MIN = 320;
/** 保存できる値の上限（書式の検査用。実際の上限は panelWidthMax が画面の幅から決める） */
export const PANEL_WIDTH_LIMIT = 1600;
/**
 * パネルの左に残す幅の下限。3日ボードでは今日の列が約 320px（予定・自分のレーンと AI のレーンが並んで読める幅）、
 * 前後の列が 100px 前後になる幅。日ビュー・Inbox もこの幅なら崩れない
 */
export const PANEL_MAIN_MIN = 640;
/** ←/→ で変える量（⇧ を押しながらは4倍） */
export const PANEL_WIDTH_STEP = 16;

/** いまの画面での最大幅。row はパネルとその左の領域を合わせた幅（測れていなければ null） */
export function panelWidthMax(row: number | null): number {
  if (row === null || !Number.isFinite(row) || row <= 0) return PANEL_WIDTH_LIMIT;
  return Math.max(
    PANEL_WIDTH_DEFAULT,
    Math.min(PANEL_WIDTH_LIMIT, Math.floor(row - PANEL_MAIN_MIN)),
  );
}

/** 保存した幅（null は既定）を、いまの画面の範囲に収める */
export function clampPanelWidth(w: number | null | undefined, row: number | null): number {
  const v = typeof w === "number" && Number.isFinite(w) ? Math.round(w) : PANEL_WIDTH_DEFAULT;
  return Math.min(Math.max(v, PANEL_WIDTH_MIN), panelWidthMax(row));
}
