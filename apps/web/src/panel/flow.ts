/**
 * この項目の流れ（D-116。AI の詳細パネルと自分の番の画面の詳細で共通）: 項目全体の稼働と待ちの区間を時刻順に並べる。
 * 直近の区間だけ出し、古い区間は「それより前 N 区間」に畳む。合計は「AI · 待ち · うち放置」。純粋関数にしてテストする
 */
import type { StoredWait, WorkItemDetail, WorkItemStatus } from "@turnlane/core/web";

/** 区間の種類。集計外は理由ごと（会議中・離席など。D-114 で「集計外」と出していたのを直した） */
export type FlowKind =
  | "run"
  | "grace"
  | "idle"
  | "event"
  | "away"
  | "snoozed"
  | "closed"
  | "no_task"
  | "scheduled"
  | "expired";

export interface FlowRow {
  kind: FlowKind;
  start: number;
  end: number;
  /** 今の区間（実行中・開いている待ちの最後。終わりは「今」） */
  now: boolean;
  /**
   * 何を頼んだか（稼働の最初のターンの指示の 1 行目）/ 何で止まったか（待ちの最初の区間。保存した待ちの中身）。
   * 保存しているときだけ（ADR 0018）
   */
  asked?: string;
  stopped?: StoredWait;
}

export interface Flow {
  rows: FlowRow[];
  /** 完了の印（状態が完了のとき。時刻は最後の区間の終わりか PR のマージ） */
  doneAt: number | null;
}

/** これより短い待ちの区間は出さない */
const MIN_ROW_MS = 60_000;
/** 実行（ターン）どうしの間がこれより短ければ1つの稼働にまとめる */
const RUN_JOIN_MS = 60_000;
/** 直近に出す区間の数（それより前は畳む。前が稼働で始まるように広げる） */
export const FLOW_VISIBLE = 5;

type Source = Pick<WorkItemDetail, "turns" | "waits" | "artifacts"> & {
  workItem: Pick<WorkItemDetail["workItem"], "status">;
  /** 開いている自分の番があれば、今の「タスクなし」は出さない（D-214 の §4。省略は今までどおり） */
  followUps?: readonly Pick<WorkItemDetail["followUps"][number], "status" | "id" | "wait">[];
};

const kindOfWait = (w: WorkItemDetail["waits"][number]): FlowKind =>
  w.kind === "excluded" ? (w.excludedBy ?? "away") : w.kind;

/** 項目全体の流れ（稼働と待ちを時刻順に。同じ種類が続く区間はまとめる） */
export function itemFlow(d: Source, now: number): Flow {
  const status: WorkItemStatus = d.workItem.status;
  const openWait = d.waits.filter((w) => w.open);
  // ブロック中・エラーで止まっている実行は、開いている待ちの始まりで切る（ボードの線と同じ）
  const cutAt =
    status === "needs_input" || status === "error"
      ? Math.min(...openWait.map((w) => w.start), Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  const runs: FlowRow[] = [];
  for (const t of [...d.turns].sort((a, b) => a.start - b.start)) {
    let end = t.open ? Math.max(t.end, now) : t.end;
    let live = t.open;
    if (t.start < cutAt && end > cutAt) {
      end = cutAt;
      live = false;
    }
    if (end <= t.start) continue;
    const prev = runs.at(-1);
    const asked = (t as { instruction?: string }).instruction;
    if (prev && t.start - prev.end < RUN_JOIN_MS) {
      prev.end = Math.max(prev.end, end);
      prev.now = prev.now || live;
      if (!prev.asked && asked) prev.asked = asked;
    } else runs.push({ kind: "run", start: t.start, end, now: live, ...(asked ? { asked } : {}) });
  }
  // 開いている待ちは、その待ちの最後の区間だけ今まで伸ばす
  const lastOpen = new Map<string, number>();
  for (const [i, w] of d.waits.entries()) if (w.open) lastOpen.set(w.waitKey, i);
  const inTurn = (d.followUps ?? []).some((f) => f.status === "open");
  const stopOf = new Map(
    (d.followUps ?? []).flatMap((f) => (f.wait && f.id ? [[f.id, f.wait] as const] : [])),
  );
  const firstOfKey = new Set<string>();
  const waits: FlowRow[] = [];
  for (const [i, w] of d.waits.entries()) {
    const live = lastOpen.get(w.waitKey) === i;
    const end = live ? Math.max(w.end, now) : w.end;
    // 自分の番に出ている間の今の区間を「タスクなし」と言わない（待ちの区間の作り直しが自分の番の作成より遅れた分）
    if (live && inTurn && w.kind === "excluded" && w.excludedBy === "no_task") continue;
    // 1分に満たない区間（猶予の終わりから返答タスクを作るまでの数秒の「タスクなし」など）は出さない
    if (end - w.start < MIN_ROW_MS) continue;
    // 待ちの最初の区間に「何で止まったか」
    const stopped =
      !firstOfKey.has(w.waitKey) && w.followUpId ? stopOf.get(w.followUpId) : undefined;
    firstOfKey.add(w.waitKey);
    waits.push({
      kind: kindOfWait(w),
      start: w.start,
      end,
      now: live,
      ...(stopped ? { stopped } : {}),
    });
  }
  const rows: FlowRow[] = [];
  for (const r of [...runs, ...waits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const prev = rows.at(-1);
    if (prev && prev.kind === r.kind && r.start - prev.end < 1000) {
      prev.end = Math.max(prev.end, r.end);
      prev.now = prev.now || r.now;
      if (!prev.asked && r.asked) prev.asked = r.asked;
      if (!prev.stopped && r.stopped) prev.stopped = r.stopped;
    } else rows.push({ ...r });
  }
  // 今の区間は最後の1つだけ
  for (const [i, r] of rows.entries()) if (i < rows.length - 1) r.now = false;
  let doneAt: number | null = null;
  if (status === "done") {
    const merged = d.artifacts.find((a) => a.kind === "pr" && a.state === "merged");
    doneAt = Math.max(rows.at(-1)?.end ?? 0, merged?.stateChangedAt ?? 0) || null;
  }
  return { rows, doneAt };
}

/** 直近だけ出す: 最後の FLOW_VISIBLE 区間（前が稼働で始まるように広げる）と、畳んだ区間の数・AI の時間 */
export function foldFlow(rows: readonly FlowRow[]): {
  shown: FlowRow[];
  earlier: { count: number; aiMs: number } | null;
} {
  let i = Math.max(0, rows.length - FLOW_VISIBLE);
  while (i > 0 && rows[i]?.kind !== "run") i--;
  if (i === 0) return { shown: [...rows], earlier: null };
  const old = rows.slice(0, i);
  return {
    shown: rows.slice(i),
    earlier: {
      count: old.length,
      aiMs: old.filter((r) => r.kind === "run").reduce((a, r) => a + (r.end - r.start), 0),
    },
  };
}

/** 数えない区間（会議中・離席など。長さは「—」、線は灰の点線） */
export function isExcluded(k: FlowKind): boolean {
  return k !== "run" && k !== "grace" && k !== "idle";
}

/**
 * 合計（「AI 1h10m · 待ち 1h24m · うち放置 24m」）。開いている待ちがあれば、待ちとうち放置はその待ちの分
 * （自分の番の行の「待ち」と同じ値）。無ければ項目のすべての待ちの分
 */
export function flowTotals(
  d: Pick<WorkItemDetail, "waits" | "breakdown">,
  now: number,
): { aiMs: number; waitMs: number; idleMs: number } {
  const open = d.waits.find((w) => w.open);
  const segs = open ? d.waits.filter((w) => w.waitKey === open.waitKey) : d.waits;
  // 開いている待ちは、その待ちの最後の区間だけ今まで伸ばす（区間はどれも open を持つ）
  const last = segs.at(-1);
  const len = (w: (typeof segs)[number]) =>
    (w.open && w === last ? Math.max(w.end, now) : w.end) - w.start;
  const waitMs = open
    ? now - Math.min(...segs.map((w) => w.start))
    : segs.reduce((a, w) => a + Math.max(0, len(w)), 0);
  const idleMs = open
    ? segs.filter((w) => w.kind === "idle").reduce((a, w) => a + Math.max(0, len(w)), 0)
    : d.breakdown.idleMs;
  return { aiMs: d.breakdown.aiMs, waitMs, idleMs };
}
