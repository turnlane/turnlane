/**
 * 待っている件の中身（GET /api/work-items/:id/glance。D-207）。行が画面に見えたときにだけ取りに行く。
 * 一覧（/api/queue）には入っていないので、SSE で一覧が流れても中身は流れない。キャッシュは短く（30 秒）、保存しない
 * （このアプリのキャッシュはメモリだけ。デーモンの応答は no-store）。
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ClosedTodayRow, GlanceResponse, QueueItem } from "@turnlane/core/web";
import { aiItemSubject, isGrace, primaryFollowUp, redact } from "@turnlane/core/web";
import { type RefObject, useEffect, useState } from "react";
import { api, unwrap } from "../lib/api.ts";

export const glanceKey = (workItemId: string) => ["glance", workItemId] as const;

/** 中身を読む待ち（PR の確認待ち・マージ待ちも、件名に使うその日の指示を読む。D-214 (1)） */
function wantsGlance(item: QueueItem): boolean {
  // 猶予中の問い（D-245）も問いの 1 行を読む（普通の行と同じ作り）
  if (isGrace(item)) return true;
  const k = primaryFollowUp(item)?.kind;
  return (
    k === "approve" ||
    k === "reply" ||
    k === "resume_error" ||
    k === "review_pr" ||
    k === "merge_pr"
  );
}

/** 設定「行に中身を出す」（turn.show_detail。既定オン） */
export function useShowDetail(): boolean {
  const q = useQuery({
    queryKey: ["settings", "config"],
    queryFn: () =>
      unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
    staleTime: 60_000,
  });
  return q.data?.["turn.show_detail"] !== false;
}

export function useGlance(
  item: QueueItem | null | undefined,
  enabled = true,
): GlanceResponse | undefined {
  const show = useShowDetail();
  const id = item?.workItemId ?? "";
  // 待ちが変われば読み直す（新しい許可待ち・返答）。問いの待ちはターンで鍵を作る: 猶予中（D-245）の行が返答タスクの
  // 普通の行に変わっても同じ鍵のまま（読み直しで理由の行がちらつかない）
  const fu = item ? primaryFollowUp(item) : undefined;
  const w = item?.wait;
  const waitPart =
    w?.turnId && (w.kind === "question" || w.kind === "ask") && (!fu || fu.kind === "reply")
      ? `turn:${w.turnId}`
      : (fu?.id ?? "");
  const q = useQuery({
    queryKey: [...glanceKey(id), waitPart, item?.status ?? ""],
    queryFn: () =>
      unwrap<GlanceResponse>(api.api["work-items"][":id"].glance.$get({ param: { id } })),
    enabled: enabled && show && item != null && wantsGlance(item),
    staleTime: 10_000,
    gcTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return show ? q.data : undefined;
}

/**
 * AI の項目の件名に使う直近の指示（待っていない項目も読む。AI の線・AI の詳細パネルの見出し。fix-stale-title）。
 * version は項目の状態・最後の活動が変わったら読み直すための鍵
 */
export function useItemGlance(
  id: string | null | undefined,
  version: string,
  enabled = true,
): GlanceResponse | undefined {
  const show = useShowDetail();
  const q = useQuery({
    queryKey: [...glanceKey(id ?? ""), "item", version],
    queryFn: () =>
      unwrap<GlanceResponse>(api.api["work-items"][":id"].glance.$get({ param: { id: id ?? "" } })),
    enabled: enabled && show && !!id,
    staleTime: 10_000,
    gcTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return show ? q.data : undefined;
}

/** 要素が一度でも画面に見えたら true（見えていない行の中身は取りに行かない） */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    const o = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setSeen(true);
        o.disconnect();
      }
    });
    o.observe(el);
    return () => o.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * AI の線（3日ボード・デイビュー）のラベルとホバーの件名（spec-glance §2.2。fix-stale-title）: 線が見えたら直近の指示を読む。
 * 線は項目ごとの件名（同じ項目の前のブロックも今の件名）。read が false でも、同じ項目の読んだものがあればそれを使う
 */
export function useAiItemSubject(
  item:
    | {
        id: string;
        title: string | null;
        titleSource: string | null;
        status: string;
        runs: readonly { start: number }[];
      }
    | null
    | undefined,
  ref: RefObject<Element | null>,
  read = true,
): string | null {
  const seen = useSeen(ref);
  const last = item ? item.runs.reduce((m, r) => Math.max(m, r.start), 0) : 0;
  const fixed = item?.titleSource === "user";
  const g = useItemGlance(item?.id, `${item?.status ?? ""}|${last}`, read && seen && !fixed);
  return item ? aiItemSubject(item, g) : null;
}

/**
 * 今日閉じた行の件名（D-214 (1)）: 自分で付けた名前が無ければ、行と同じ glance の件名（直近の意味のある指示）を読む。読めなければ fallback
 * （作ったときの件名）
 */
export function useClosedSubject(
  row: Pick<ClosedTodayRow, "workItemId" | "userTitled">,
  ref: RefObject<Element | null>,
  fallback: string,
): string {
  const seen = useSeen(ref);
  const g = useItemGlance(row.workItemId, "closed", seen && !row.userTitled);
  const p = row.userTitled ? undefined : g?.prompt?.text;
  return p ? redact(p).text : fallback;
}

/**
 * 見出しの「期限切れ」のホバーの件名（R79）: 「今日閉じた」の行（useClosedSubject）と同じ件名にするため、同じ鍵で直近の指示を読む
 * （行と同じキャッシュ）。followUpId → 件名。読めない行・自分で付けた名前の行は入れない（呼ぶ側が既定の件名にする）
 */
export function useClosedSubjects(
  rows: readonly Pick<ClosedTodayRow, "followUpId" | "workItemId" | "userTitled">[],
): Map<string, string> {
  const show = useShowDetail();
  const qs = useQueries({
    queries: rows.map((r) => ({
      queryKey: [...glanceKey(r.workItemId), "item", "closed"],
      queryFn: () =>
        unwrap<GlanceResponse>(
          api.api["work-items"][":id"].glance.$get({ param: { id: r.workItemId } }),
        ),
      enabled: show && !r.userTitled,
      staleTime: 10_000,
      gcTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
  const m = new Map<string, string>();
  if (!show) return m;
  rows.forEach((r, i) => {
    const p = r.userTitled ? undefined : qs[i]?.data?.prompt?.text;
    if (p) m.set(r.followUpId, redact(p).text);
  });
  return m;
}
