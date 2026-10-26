/**
 * 利用計測（M5-1）: UI を開いたことを POST /api/usage { kind: "ui_open" } で残す。14日カウント（D-006）の
 * 「UI を開いた日」に使う。本人の操作には数えない（サーバーが /api/usage を除外する）。
 * 開いたとき（見えているとき）と、論理日付が変わった後に見えたときに1回ずつ送る。
 */
import { useEffect } from "react";
import { api } from "../lib/api.ts";
import { getUi, useUi } from "../lib/store.ts";

let lastSent: string | null = null;

function send(today: string | null): void {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  const key = today ?? "";
  if (lastSent === key) return;
  lastSent = key;
  void api.api.usage.$post({ json: { kind: "ui_open" } }).catch(() => {
    lastSent = null;
  });
}

export function useUiOpen(): void {
  const today = useUi((s) => s.serverToday);
  useEffect(() => {
    // 最初の1回は「今日」が分かる前でも送る（サーバーが論理日付を決める）
    if (lastSent === null || (today !== null && lastSent !== today && lastSent !== "")) send(today);
    else if (lastSent === "" && today !== null) lastSent = today;
  }, [today]);
  useEffect(() => {
    const onVis = () => send(getUi().serverToday);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
}
