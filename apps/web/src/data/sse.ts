/**
 * SSE（/api/events）→ キャッシュの無効化（m2-api.md 3章・4.3）。
 * - イベントはデータを持たない合図。種類と日付・ID から該当キーを invalidate する
 * - 再接続時は hello の bootId / rev で取りこぼしを判定し、取りこぼしていれば全部無効化する
 * - スリープ復帰（visible に戻った、または 30秒以上ハートビートも来ない）でも同じ判定をする
 */
import type { SseEventType } from "@turnlane/core/web";
import { useEffect, useState } from "react";
import { getUi, setUi } from "../lib/store.ts";
import { noteInvalidated, queryClient } from "./client.ts";
import { type EventData, needsFullRefresh, shouldInvalidate } from "./invalidate.ts";

export type ConnState = "connecting" | "open" | "down";

const TYPES: SseEventType[] = [
  "task",
  "work_item",
  "follow_up",
  "calendar",
  "plan_guide",
  "source",
  "day_boundary",
  "settings",
  "daily_note",
  "desktop_status",
  "focus",
  // オンボーディング（onboarding.md 5.1・5.3）
  "onboarding",
  "import_progress",
  // 拡張（ADR 0015）のキャッシュ
  "ext",
  // 更新確認の結果（ボードの上部の更新の知らせ。M6-17）
  "update",
  // 集中の終わりのまとめ（focus-summary）をブラウザ通知に出す（D-097。他の notify は無視する）
  "notify",
];

type Listener = (type: SseEventType, data: EventData & { rev?: number }) => void;
const listeners = new Set<Listener>();

/** SSE のイベントを購読する（通知・トーストなど、無効化以外の用途） */
export function onSse(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let today = "";
export function currentToday(): string {
  return today;
}
export function setToday(d: string): void {
  today = d;
  if (getUi().serverToday !== d) setUi({ serverToday: d });
}

/** 表示の「今日」（暦日。D-054）を覚える。変わったら true */
function setDisplayToday(d: string | undefined): boolean {
  if (!d || getUi().serverDisplayToday === d) return false;
  const changed = getUi().serverDisplayToday !== null;
  setUi({ serverDisplayToday: d });
  return changed;
}

export function useLiveUpdates(): ConnState {
  const [state, setState] = useState<ConnState>("connecting");
  useEffect(() => {
    let es: EventSource | null = null;
    let last: { bootId: string; lastRev: number } | null = null;
    let lastSeen = Date.now();
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es?.close();
      es = new EventSource("/api/events", { withCredentials: true });
      setState("connecting");
      es.addEventListener("open", () => {
        lastSeen = Date.now();
      });
      es.addEventListener("ping", () => {
        lastSeen = Date.now();
      });
      es.addEventListener("hello", (ev) => {
        lastSeen = Date.now();
        setState("open");
        const h = JSON.parse((ev as MessageEvent<string>).data) as {
          bootId: string;
          rev: number;
          today: string;
          displayToday?: string;
        };
        const displayChanged = setDisplayToday(h.displayToday);
        if (h.today && h.today !== today) {
          const changed = today !== "";
          setToday(h.today);
          if (changed) void queryClient.invalidateQueries();
        } else if (displayChanged) void queryClient.invalidateQueries();
        if (needsFullRefresh(last, h)) void queryClient.invalidateQueries();
        last = { bootId: h.bootId, lastRev: h.rev };
      });
      for (const type of TYPES) {
        es.addEventListener(type, (ev) => {
          lastSeen = Date.now();
          let data: EventData & { rev?: number; today?: string; displayToday?: string } = {};
          try {
            data = JSON.parse((ev as MessageEvent<string>).data) as typeof data;
          } catch {}
          if (typeof data.rev === "number" && last) last.lastRev = Math.max(last.lastRev, data.rev);
          if (type === "day_boundary" && data.today) setToday(data.today);
          if (type === "day_boundary") setDisplayToday(data.displayToday);
          const rev = data.rev ?? 0;
          void queryClient.invalidateQueries({
            predicate: (q) => {
              const hit = shouldInvalidate(q.queryKey, type, data, today);
              if (hit) noteInvalidated(q.queryKey, rev);
              return hit;
            },
          });
          for (const l of listeners) l(type, data);
        });
      }
      es.addEventListener("error", () => {
        // EventSource は自動で再接続する。閉じられた（CLOSED）ときだけ自分でつなぎ直す
        if (es?.readyState === EventSource.CLOSED) {
          setState("down");
          if (!closed) retry = setTimeout(connect, 3000);
        } else setState("connecting");
      });
    };
    connect();

    // ハートビート（15秒ごとの ping）が45秒来なければ、スリープ復帰などで切れたとみなして接続し直し、hello で判定する
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > 45_000) {
        lastSeen = Date.now();
        connect();
      }
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastSeen > 30_000) {
        lastSeen = Date.now();
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      es?.close();
    };
  }, []);
  return state;
}
