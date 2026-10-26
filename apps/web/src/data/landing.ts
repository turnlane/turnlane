/**
 * 動いているセッションを開いたときの着地（D-214 (4)。desktop-shell.md 4.4）を、行の「対応中」の後ろに残す
 * （「対応中 · iTerm2 · タブ 3」）。知らせ（トースト）は消えるので、どこを開いたかを行で読めるようにする。
 * メニューバーのポップオーバーは開くとすぐ隠れるので、次に出したときに行で読める。
 * 端末ごとにブラウザに保存する（main とポップオーバーは同じオリジンなので共有。storage イベントで追従）。
 * 読めない・書けないときは何も残さない
 */
import type { OpenLanding } from "@turnlane/core/api";
import { useSyncExternalStore } from "react";

const KEY = "turnlane.open.landing";
const MAX = 50;
/** これより古い着地は出さない（同じ件をあとで別の場所から開いたかもしれない） */
const TTL_MS = 12 * 60 * 60_000;

export interface StoredLanding {
  app: string;
  landing: OpenLanding;
  at: number;
}

type Map = Record<string, StoredLanding>;

function read(): Map {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Map) : {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let cache: { raw: string | null; map: Map } | null = null;

function snapshot(): Map {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {}
  if (!cache || cache.raw !== raw) cache = { raw, map: read() };
  return cache.map;
}

export function rememberLanding(followUpId: string, v: StoredLanding): void {
  try {
    const m = { ...read(), [followUpId]: v };
    const keep = Object.entries(m)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** その件の最後の着地（無い・古いときは null） */
export function useLanding(followUpId: string | undefined, now: number): StoredLanding | null {
  const m = useSyncExternalStore(subscribe, snapshot, () => ({}) as Map);
  const v = followUpId ? m[followUpId] : undefined;
  return v && now - v.at <= TTL_MS ? v : null;
}
