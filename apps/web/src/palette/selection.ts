/**
 * 画面とパレットのつなぎ（ux-mvp 6.1）:
 * - usePublishSelection: 画面で選んでいる項目をストアに書く（⌘K の Selected と `p` が読む）。アンマウントで消す
 * - useFocusRequest: ⌘K の検索結果から移動してきたとき、その項目を画面で選ぶ
 */
import { useEffect, useRef } from "react";
import { getUi, type SelItem, setUi, useUi } from "../lib/store.ts";

function sig(x: SelItem): string {
  if (x.kind === "task")
    return `task:${x.task.id}:${x.task.scheduledDate ?? ""}:${x.task.estimateMin ?? ""}:${x.task.status}`;
  if (x.kind === "turn") return `turn:${x.item.workItemId}:${x.item.followUps.length}`;
  return `ai:${x.id}:${x.title ?? ""}`;
}

export function usePublishSelection(items: SelItem[]): void {
  const ref = useRef(items);
  ref.current = items;
  const key = items.map(sig).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 中身の変化（key）だけで書き直す
  useEffect(() => {
    setUi({ selection: ref.current });
  }, [key]);
  useEffect(() => () => setUi({ selection: [] }), []);
}

/**
 * 移動先の画面で選ぶ項目（`task:<id>`）。accept が true を返したら（その画面に項目があったら）消す。
 * データの読み込みを待つため、データが変わるたびに試す
 */
export function useFocusRequest(
  accept: (f: { key: string; date: string | null }) => boolean,
  deps: unknown[],
): void {
  const focus = useUi((s) => s.focus);
  const ref = useRef(accept);
  ref.current = accept;
  // biome-ignore lint/correctness/useExhaustiveDependencies: データ（deps）が届くたびに試す
  useEffect(() => {
    const f = getUi().focus;
    if (!f) return;
    if (ref.current(f)) {
      setUi({ focus: null });
      // 選んだ項目を見える位置へ
      const [kind, id] = f.key.split(":");
      setTimeout(
        () =>
          document
            .querySelector(`[data-kind="${kind}"][data-id="${id}"]`)
            ?.scrollIntoView({ block: "nearest" }),
        0,
      );
    }
  }, [focus, ...deps]);
}
