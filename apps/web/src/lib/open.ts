/**
 * 画面の移動と AI 詳細パネルを開く（main.tsx の __turnlaneOpen と、拡張の `@turnlane/ext-host` の navigate / openAiPanel）。
 * ルーターは main.tsx が setAppNavigate で渡す（ここからルーターを import すると拡張の一覧と循環するため）。
 * 小さなウインドウ（メニューバーのポップオーバー・クイック入力）からは main のウインドウを出して開く（desktopOpen）
 */
import { desktopOpen, panelPath, takePanelParam } from "./desktop.ts";
import { setUi } from "./store.ts";

let navigateImpl: ((path: string) => void) | null = null;
/** 詳細パネルを出せる枠（AppShell）が出ている数 */
let shells = 0;

/** main.tsx がルーターの移動を渡す */
export function setAppNavigate(f: (path: string) => void): void {
  navigateImpl = f;
}

/** AppShell が出ている間（詳細パネルをその場で開ける） */
export function markShell(): () => void {
  shells++;
  return () => {
    shells--;
  };
}

const SMALL_WINDOWS = ["/tray", "/quick-add"];

function inSmallWindow(): boolean {
  return typeof location !== "undefined" && SMALL_WINDOWS.includes(location.pathname);
}

/** path の画面へ移る（`?panel=<workItemId>` なら AI 詳細パネルも開く） */
export function openInApp(href: string): void {
  if (inSmallWindow()) {
    desktopOpen(href);
    return;
  }
  const { path, panel, answer } = takePanelParam(href);
  if (navigateImpl) navigateImpl(path);
  else if (typeof location !== "undefined") location.assign(path);
  if (panel) setUi({ panelWorkItemId: panel, answerFor: answer ? panel : null });
}

/** AI 詳細パネルを開く。枠の中の画面ならその場で、儀式・枠なしの画面からは週ボードへ移って開く */
export function openAiPanelInApp(workItemId: string): void {
  if (shells > 0 && !inSmallWindow()) setUi({ panelWorkItemId: workItemId });
  else openInApp(panelPath(workItemId));
}

/** タスクの詳細パネルを開く。枠の中の画面ならその場で、儀式・枠なしの画面からは週ボードへ移って開く */
export function openTaskPanelInApp(taskId: string): void {
  if (inSmallWindow()) {
    desktopOpen("/board");
    return;
  }
  if (shells === 0) openInApp("/board");
  setUi({ panelTaskId: taskId });
}
