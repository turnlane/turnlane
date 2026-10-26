import { useEffect, useState } from "react";

/**
 * サーバーの時計に合わせた現在時刻。読み取り応答の now との差を覚え、進行中の区間と現在線を描き足すのに使う
 * （m2-api.md 3.1。ブラウザとデーモンは同じ Mac なので差は小さいが、開発用の偽の時計でも正しく描けるようにする）。
 */
let offset = 0;

export function noteServerNow(serverNow: number): void {
  offset = serverNow - Date.now();
}

export function nowMs(): number {
  return Date.now() + offset;
}

/** 30秒ごとに進む現在時刻（開いている区間を描き足す。m2-api.md 3.1） */
export function useNow(intervalMs = 30_000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(i);
  }, [intervalMs]);
  return nowMs();
}
