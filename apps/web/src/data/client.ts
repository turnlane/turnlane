/**
 * クライアントのデータ層（m2-api.md 4章）。TanStack Query のキャッシュを SSE で無効化する。
 * staleTime: Infinity（鮮度は SSE が保証する）、refetchOnWindowFocus: false（スリープ復帰は sse.ts で扱う）。
 */
import { QueryClient } from "@tanstack/react-query";
import { noteServerNow } from "../lib/clock.ts";
import { getUi, setUi } from "../lib/store.ts";
import type { Key } from "./invalidate.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false,
      retry: 1,
      gcTime: 5 * 60_000,
    },
  },
});

/** キー → そのキーを無効化した最後のイベントの rev（4.3: 古い応答で上書きしない） */
const minRev = new Map<string, number>();

export function noteInvalidated(key: Key, rev: number): void {
  const k = JSON.stringify(key);
  minRev.set(k, Math.max(minRev.get(k) ?? 0, rev));
}

/**
 * rev 付きの読み取り。応答の rev が、そのキーを無効化したイベントの rev より小さければ1回だけ取り直す
 * （イベントと読み取りが行き違ったとき）
 */
export async function fetchWithRev<
  T extends { rev: number; now?: number; today?: string; displayToday?: string },
>(key: Key, load: () => Promise<T>): Promise<T> {
  const want = minRev.get(JSON.stringify(key)) ?? 0;
  const first = await load();
  const r = first.rev >= want ? first : await load();
  if (typeof r.now === "number") noteServerNow(r.now);
  if (typeof r.today === "string" && getUi().serverToday !== r.today)
    setUi({ serverToday: r.today });
  if (typeof r.displayToday === "string" && getUi().serverDisplayToday !== r.displayToday)
    setUi({ serverDisplayToday: r.displayToday });
  return r;
}
