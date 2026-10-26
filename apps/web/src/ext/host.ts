/**
 * 本体が拡張（Web 側。ADR 0015）に公開する部品と口。拡張は `@turnlane/ext-host`（Vite の alias でこのファイル）から import する。
 * ここに無いもの（本体の内部のモジュール）を拡張から import しない。足すときは互換を保つか EXT_API_VERSION を上げる
 */
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { queryClient } from "../data/client.ts";
import { openTask } from "../data/mutations.ts";
import { useKeys as useCoreKeys } from "../keys/use-keys.ts";
import { ApiError } from "../lib/api.ts";
import { openAiPanelInApp, openInApp, openTaskPanelInApp } from "../lib/open.ts";
import type { ExtKeyHandlers, ExtOpenAction } from "./types.ts";

export { StatusIcon } from "../components/StatusIcon.tsx";
export { Button, Chip, ConfirmDialog, Kbd, Popover } from "../components/ui.tsx";
export { useI18n, useT } from "../i18n/index.tsx";
export { LaunchRow } from "../launch/LaunchRow.tsx";
export { LaunchSegmented, Picker, Switch } from "../launch/Picker.tsx";
export { useNow } from "../lib/clock.ts";
export { toast } from "../lib/store.ts";
/** 設定の画面の地（背景）の上の分割ボタン。ポップオーバーの中では LaunchSegmented を使う（面が同じ色で印が見えない） */
export { Segmented } from "../routes/SettingsSections.tsx";
export {
  type ExtIcon,
  type ExtLineIcon,
  type ExtTone,
  Icon,
  type IconProps,
  SidebarNotice,
  type SidebarNoticeProps,
  TodayNotice,
  type TodayNoticeProps,
  TrayRow,
  type TrayRowProps,
} from "./parts.tsx";
export { ApiError };

/** 拡張のキャッシュのキー（SSE の `ext` イベントで取り直す） */
export const extQueryKey = (id: string, ...rest: unknown[]) => ["ext", id, ...rest] as const;

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === "string") code = b.error;
    } catch {}
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

/** 拡張のルート（`/api/ext/<id>/*`）を呼ぶ。失敗は ApiError（status と code） */
export function extApi(id: string) {
  const url = (path: string) => `/api/ext/${id}${path.startsWith("/") ? path : `/${path}`}`;
  return {
    get: <T>(path: string) => call<T>("GET", url(path)),
    post: <T>(path: string, body?: unknown) => call<T>("POST", url(path), body ?? {}),
    put: <T>(path: string, body: unknown) => call<T>("PUT", url(path), body),
    delete: <T>(path: string) => call<T>("DELETE", url(path)),
  };
}

/** 拡張のルートの GET をキャッシュ付きで読む */
export function useExtQuery<T>(id: string, path: string): UseQueryResult<T, Error> {
  return useQuery({
    queryKey: extQueryKey(id, path),
    queryFn: () => extApi(id).get<T>(path),
    retry: false,
  });
}

/** 拡張のキャッシュをすべて取り直す */
export function invalidateExt(id: string): void {
  void queryClient.invalidateQueries({ queryKey: extQueryKey(id) });
}

/**
 * 拡張の画面（`/ext/<id>/…` の経路）と部品でキーを受ける（アンマウントで外れる）。受けられるキーは ExtKeyId だけ。
 * 後から登録した処理（開いたポップオーバーなど）が先に呼ばれ、false を返すと次へ回る
 */
export function useKeys(handlers: ExtKeyHandlers): void {
  useCoreKeys(handlers);
}

/**
 * 本体の画面へ移る（`/board`・`/day`・`/inbox`・`/ext/<id>/…` など。`?panel=<workItemId>` を付けると AI 詳細パネルも開く）。
 * メニューバーのポップオーバーからは main のウインドウを出して開く
 */
export function navigate(path: string): void {
  openInApp(path);
}

/** AI 詳細パネルを開く。枠の中の画面ならその場で、枠なしの画面からは週ボードへ移って開く */
export function openAiPanel(workItemId: string): void {
  openAiPanelInApp(workItemId);
}

/** タスクの詳細パネルを開く。枠の中の画面ならその場で、枠なしの画面からは週ボードへ移って開く */
export function openTaskPanel(taskId: string): void {
  openTaskPanelInApp(taskId);
}

/**
 * 本体の開き方で AI を開く（AI 詳細パネルの「開く」・タスクの頼んだ AI の「開く」と同じ。m2-api 13章）。action を省くと
 * 本体の既定（open なフォローアップの既定、無ければ PR → セッション → フォルダ）。`"session"` は端末で開く（設定の端末で
 * resume を入力済みにする。開けなければコマンドをコピー）。結果は本体がトーストで知らせる。開けたら true
 */
export async function openAi(workItemId: string, action?: ExtOpenAction): Promise<boolean> {
  const r = await openTask({ workItemId, ...(action ? { action } : {}) });
  return r !== null;
}
