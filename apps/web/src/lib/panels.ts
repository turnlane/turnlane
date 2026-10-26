/**
 * 詳細パネル（AI・タスク・予定）を出せる画面か（D-070）。AppShell の中だけ true。
 * 儀式の画面（朝の計画 Step 3 の今日の列など）は同じ部品を使うが、パネルは出さない。
 */
import { createContext, useContext } from "react";

export const PanelsAvailable = createContext(false);

export function usePanelsAvailable(): boolean {
  return useContext(PanelsAvailable);
}
