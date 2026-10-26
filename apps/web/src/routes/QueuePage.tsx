/**
 * 要対応キュー（S5。M2-6、ux-mvp 4.6。確定デザインの「自分の番」Q1・Q2・空の状態）: 未処理の自分の番の全件を、状態の重さ → 待ちの
 * 長い順で（ブロック中が先頭で琥珀の面）。上に絞り込み（すべて · ブロック中 · 返答 · レビュー · エラー）、行は2行（題名 / リポジトリ ·
 * ブランチ、右に待ち）、行を選ぶと右に 380px の詳細（状態・PR・この項目の流れ・開いて対応 / 移動 / スヌーズ / 対応不要）。
 * 帯と同じデータ・同じ順。
 * 操作: ⏎（タスクの既定の開き先を開き、対応中の印。D-059）、o 他の開き方、m 明日（次の稼働日へ移し計画の目安の開始までスヌーズ。D-052 (1)）、s スヌーズ、e 対応不要、Space 完了、x で選んだ複数件への一括適用。平均応答時間。
 * 一覧の下に「後で N」の節（スヌーズ中・明日へ・リセット前の上限待ち。戻る時刻つきで薄く。帯・件数・通知には入れない）。
 * j / k は節をまたいで動き、後での行は ⏎ 開く・e 対応不要・今やる（スヌーズ解除）だけ（s / m / Space は効かない）。
 */

import { useRouterState } from "@tanstack/react-router";
import {
  fmtDuration,
  fmtWait,
  isLater,
  laterFollowUp,
  laterRows,
  nextWeekday,
  prLabel,
  type QueueItem,
} from "@turnlane/core/web";
import { ChevronDown, ChevronRight, GitPullRequest, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ItemActionsProvider,
  rangeKeys,
  toggleKey,
  useItemActionsHost,
} from "../actions/item-actions.tsx";
import { type Prompt, PromptView } from "../board/editors.tsx";
import { AnswerSection, openAnswer, useAnswerOpen } from "../components/AnswerSection.tsx";
import { BulkBar } from "../components/BulkBar.tsx";
import { FlowSection } from "../components/Flow.tsx";
import { titleText } from "../components/items.tsx";
import {
  LaterRow,
  laterLabel,
  laterViewItem,
  readLaterOpen,
  writeLaterOpen,
} from "../components/LaterRow.tsx";
import { Nums } from "../components/Nums.tsx";
import { useOpenWith } from "../components/OpenWith.tsx";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { ClosedFold, ClosedTurnRow, primaryFollowUp, TurnRow } from "../components/TurnRow.tsx";
import { turnView, WhyBlock } from "../components/TurnWhy.tsx";
import { Button } from "../components/ui.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { useGlance } from "../data/glance.ts";
import {
  completeItems,
  deferFollowUp,
  dismissFollowUps,
  dismissLimitWait,
  openTask,
  snoozeFollowUp,
  wakeFollowUp,
} from "../data/mutations.ts";
import { countedTurns, isGrace, turnRows, useQueue, useWorkItem } from "../data/queries.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { dispatchKey, useKeys } from "../keys/use-keys.ts";
import { CheckRows, hasCheckRows, useCheck } from "../launch/CheckRows.tsx";
import { useNow } from "../lib/clock.ts";
import { useFitSteps } from "../lib/fit.ts";
import type { SelItem } from "../lib/store.ts";
import { whereName } from "../lib/where.ts";
import { usePublishSelection } from "../palette/selection.ts";
import { prStateKey } from "../panel/ai-state.ts";
import { ResizablePanel } from "../panel/ResizablePanel.tsx";

/** 絞り込みの区分（ブロック中 = 許可待ち、エラー、レビュー = PR のレビュー、返答 = それ以外） */
export type QueueFilter = "all" | "blocked" | "reply" | "review" | "error";
const FILTERS: QueueFilter[] = ["all", "blocked", "reply", "review", "error"];

export function filterOf(x: QueueItem): Exclude<QueueFilter, "all"> {
  // 猶予中の問い（D-245）は返答待ち
  if (isGrace(x)) return "reply";
  if (x.status === "needs_input") return "blocked";
  if (x.status === "error") return "error";
  return primaryFollowUp(x)?.kind === "review_pr" ? "review" : "reply";
}

export function QueuePage() {
  const { t } = useI18n();
  const q = useQueue();
  // 自分の番の行（猶予中の問いを末尾に薄く。D-245）。タブの件数は猶予中を含めない
  const all = turnRows(q.data?.items, q.data?.grace);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const items = filter === "all" ? all : all.filter((x) => filterOf(x) === filter);
  const [detailOpen, setDetailOpen] = useState(true);
  // 後で（スヌーズ中・明日へ・時間に置いた開始の前・リセット前の上限待ち）。絞り込みが「すべて」のときだけ一覧の下に出す
  const later = filter === "all" ? laterRows(q.data?.items, q.data?.limitWaits) : [];
  const [laterOpen, setLaterOpen] = useState(readLaterOpen);
  // j / k で動く行（一覧 → 開いた後での節）
  const rows = laterOpen ? [...items, ...later] : items;
  const [cur, setCur] = useState(0);
  const [multi, setMulti] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const now = useNow();
  const tz = q.data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sel = rows[Math.min(cur, rows.length - 1)];
  const selLater = sel !== undefined && isLater(sel);
  const today = q.data?.today ?? "";
  // /queue?item=<workItemId>（通知のクリック）: その行を選んで見える位置へ
  const target = useRouterState({ select: (s) => (s.location.search as { item?: unknown }).item });
  const targetIndex =
    typeof target === "string" ? rows.findIndex((x) => x.workItemId === target) : -1;
  useEffect(() => {
    if (targetIndex < 0 || typeof target !== "string") return;
    setCur(targetIndex);
    document
      .querySelector(`[data-kind="turn"][data-id="${CSS.escape(target)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [targetIndex, target]);
  const targets = (): QueueItem[] =>
    multi.length > 0 ? rows.filter((x) => multi.includes(x.workItemId)) : sel ? [sel] : [];
  const fuIds = () =>
    targets()
      .map((x) => primaryFollowUp(x)?.id)
      .filter((x): x is string => !!x);
  const anchor = () =>
    sel
      ? document.querySelector<HTMLElement>(`[data-kind="turn"][data-id="${sel.workItemId}"]`)
      : null;
  const openWith = useOpenWith();
  const answerOn = useAnswerEnabled();
  useKeys({
    next: () => {
      setCur((c) => Math.min(rows.length - 1, c + 1));
      return true;
    },
    // a: 選んでいる行の「答える」の節を右の詳細に開く（D-238）
    answer: () => {
      if (!sel || selLater || !answerOn || !answerable(sel)) return false;
      setDetailOpen(true);
      openAnswer(sel.workItemId);
      return true;
    },
    prev: () => {
      setCur((c) => Math.max(0, c - 1));
      return true;
    },
    extendDown: () => {
      if (selLater) return false;
      if (sel) setMulti((m) => [...new Set([...m, sel.workItemId])]);
      setCur((c) => Math.min(items.length - 1, c + 1));
      return true;
    },
    extendUp: () => {
      if (selLater) return false;
      if (sel) setMulti((m) => [...new Set([...m, sel.workItemId])]);
      setCur((c) => Math.max(0, c - 1));
      return true;
    },
    select: () => {
      if (!sel || selLater) return false;
      const id = sel.workItemId;
      setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
      return true;
    },
    open: () => {
      if (!sel) return false;
      // 後での行: スヌーズ中のフォローアップを開く（開いて対応と同じ。スヌーズは終わる）。上限待ちは項目の既定の開き先
      const f = selLater ? laterFollowUp(sel) : primaryFollowUp(sel);
      // 猶予中の問い（D-245）は返答タスクが無いので項目の既定の開き先
      void openTask(f ? { followUpId: f.id } : { workItemId: sel.workItemId });
      return true;
    },
    openWith: () => {
      const f = sel && !selLater ? primaryFollowUp(sel) : undefined;
      if (!sel || !f) return false;
      openWith.show(anchor(), { followUpId: f.id });
      return true;
    },
    detail: () => {
      if (!sel) return false;
      setDetailOpen(true);
      return true;
    },
    complete: () => {
      if (selLater && multi.length === 0) return false;
      void completeItems([], fuIds());
      setMulti([]);
      return true;
    },
    dismiss: () => {
      if (sel && selLater && multi.length === 0) {
        const f = laterFollowUp(sel);
        void (f ? dismissFollowUps([f.id]) : dismissLimitWait(sel.workItemId));
        return true;
      }
      void dismissFollowUps(fuIds());
      setMulti([]);
      return true;
    },
    // 今やる（後での行。スヌーズを外して帯に戻す。上限待ちの行には無い）
    wake: () => {
      const f = sel && selLater ? laterFollowUp(sel) : undefined;
      if (!f || !today) return false;
      void wakeFollowUp(f.id, today);
      return true;
    },
    move: () => {
      if (selLater && multi.length === 0) return false;
      const ids = fuIds();
      const today = q.data?.today;
      if (ids.length === 0 || !today) return false;
      for (const id of ids) void deferFollowUp(id, nextWeekday(today));
      setMulti([]);
      return true;
    },
    snooze: () => {
      if (selLater && multi.length === 0) return false;
      const ids = fuIds();
      if (ids.length === 0) return false;
      setPrompt({
        kind: "snooze",
        anchor: anchor(),
        onSubmit: (p) => {
          for (const id of ids) void snoozeFollowUp(id, p);
          setMulti([]);
        },
      });
      return true;
    },
    escape: () => {
      if (multi.length === 0) return false;
      setMulti([]);
      return true;
    },
  });
  // ⌘K（ux-mvp 6.1）: 選んでいる行をパレットに渡す
  usePublishSelection(targets().map((item): SelItem => ({ kind: "turn", item })));
  // マウスの操作（UX 監査 A1〜A3・A14）: 1クリックで選択と AI 詳細パネル、⇧ / ⌘ クリックで複数選択、右クリック・ホバーのボタン
  const keyOf = (x: QueueItem) => `turn:${x.workItemId}`;
  const idOf = (k: string) => k.slice(5);
  const host = useItemActionsHost({
    select: (k, how) => {
      const i = rows.findIndex((x) => keyOf(x) === k);
      if (i < 0) return;
      const curKey = sel ? keyOf(sel) : null;
      if (how === "replace") setMulti([]);
      else if (how === "toggle")
        setMulti(
          toggleKey(
            multi.map((id) => `turn:${id}`),
            curKey,
            k,
          ).map(idOf),
        );
      else setMulti(rangeKeys(rows.map(keyOf), curKey, k).map(idOf));
      setCur(i);
    },
    // 詳細はこの画面の右の 380px（確定デザイン）。全体の AI 詳細パネルは開かない
    openDetail: () => setDetailOpen(true),
    inMulti: (k) => multi.includes(idOf(k)),
    itemsFor: (k) =>
      (multi.includes(idOf(k))
        ? rows.filter((x) => multi.includes(x.workItemId))
        : rows.filter((x) => keyOf(x) === k)
      ).map((item): SelItem => ({ kind: "turn", item })),
  });
  const closedRows = (q.data?.closedRows ?? []).filter(
    (r) => r.kind === "replied" || r.kind === "resolved",
  );
  const closedCount = Object.values(q.data?.closedToday ?? {}).reduce((x, n) => x + n, 0);
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f, countedTurns(f === "all" ? all : all.filter((x) => filterOf(x) === f))]),
  ) as Record<QueueFilter, number>;
  const showDetail = detailOpen && sel !== undefined;
  const headRef = useRef<HTMLDivElement>(null);
  const omit = useFitSteps(headRef, 2);
  return (
    <ItemActionsProvider value={host.api}>
      <div className="flex h-full min-w-0">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-8 py-6">
          {/* 折り返さない。入らなければ 右の 2 つを短く → タブの件数を省く → タブの行を横スクロール（B-1 (1)・§4） */}
          <div
            ref={headRef}
            className="flex items-center gap-3 overflow-hidden whitespace-nowrap"
            data-omit={omit}
          >
            {/* 絞り込み（件数付き） */}
            <div
              className={`flex min-w-0 items-center gap-0.5 rounded-card bg-sunken p-1 ${omit >= 2 ? "overflow-x-auto [mask-image:linear-gradient(90deg,transparent,black_12px,black_calc(100%-12px),transparent)]" : "shrink-0"}`}
              role="tablist"
              data-testid="queue-filter"
            >
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => {
                    setFilter(f);
                    setCur(0);
                    setMulti([]);
                  }}
                  data-filter={f}
                  className={`flex h-8 items-center gap-1.5 rounded-control px-3 font-medium text-body ${
                    filter === f
                      ? "bg-raised text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--dl-border)]"
                      : "text-fg2 hover:text-fg"
                  }`}
                >
                  {t(`queue.filter.${f}` as MessageKey)}
                  {omit >= 2 ? null : <span className="text-fg3 text-meta">{counts[f]}</span>}
                </button>
              ))}
            </div>
            <div className="ml-auto flex shrink-0 gap-3 text-fg3 text-meta">
              {multi.length > 0 ? (
                <span>{t("queue.selected", { count: multi.length })}</span>
              ) : null}
              {/* 主要指標「処理 N 件（7日）」（D-192 §4。0 なら出さない）。平均応答の左に「 · 」で並べる */}
              {q.data && q.data.handled7d > 0 ? (
                <span
                  className="border-fg3 border-b border-dotted"
                  title={t("queue.handled.def")}
                  data-testid="queue-handled"
                >
                  <Nums
                    text={t(omit >= 1 ? "queue.handled.short" : "queue.handled", {
                      count: q.data.handled7d,
                    })}
                  />
                </span>
              ) : null}
              {q.data && q.data.handled7d > 0 && q.data.avgResponseMs != null ? (
                <span aria-hidden="true">·</span>
              ) : null}
              {q.data?.avgResponseMs != null ? (
                <Nums
                  text={t(omit >= 1 ? "queue.avgResponse.short" : "queue.avgResponse", {
                    time: fmtDuration(q.data.avgResponseMs),
                  })}
                />
              ) : null}
            </div>
          </div>
          {all.length === 0 && later.length === 0 && q.isSuccess ? (
            // 空の状態（文字だけ。確定デザイン）
            <div
              className="flex flex-1 flex-col items-center justify-center gap-2 pb-24 text-center"
              data-testid="queue-empty"
            >
              <p className="font-semibold text-fg text-section">{t("queue.emptyTitle")}</p>
              <p className="text-body text-fg2">{t("queue.emptyHint")}</p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {items.map((x, i) => (
              <TurnRow
                key={x.workItemId}
                item={x}
                now={now}
                tz={tz}
                variant="queue"
                selected={i === cur && showDetail}
                checked={multi.includes(x.workItemId)}
                onOpen={() => {
                  const f = primaryFollowUp(x);
                  void openTask(f ? { followUpId: f.id } : { workItemId: x.workItemId });
                }}
              />
            ))}
          </div>
          {later.length > 0 ? (
            // 後で（スヌーズ中・明日へ・時間に置いた・リセット前の上限待ち）: 一覧の下に薄く、戻る時刻つき。既定は開いた状態
            <section className="flex flex-col gap-1.5" data-testid="queue-later">
              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  setLaterOpen(!laterOpen);
                  writeLaterOpen(!laterOpen);
                  if (laterOpen && cur >= items.length) setCur(Math.max(0, items.length - 1));
                }}
                aria-expanded={laterOpen}
                className="flex h-7 items-center gap-1.5 self-start rounded-control px-1 text-fg2 text-meta hover:text-fg"
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className={laterOpen ? "rotate-90" : ""}
                />
                <span>{t("queue.later", { count: later.length })}</span>
              </button>
              {laterOpen
                ? later.map((x, i) => (
                    <LaterRow
                      key={x.workItemId}
                      item={x}
                      now={now}
                      tz={tz}
                      today={today}
                      selected={items.length + i === cur && showDetail}
                    />
                  ))
                : null}
            </section>
          ) : null}
          {closedCount > 0 ? (
            // 今日閉じたものは畳んで静かに（確定デザイン「今日閉じた 4 ▸」）
            <section className="pl-2" data-testid="queue-closed">
              <ClosedFold count={closedCount}>
                <div className="flex flex-col">
                  <p className="px-2 pb-1 text-fg3 text-meta">
                    {(["replied", "resolved", "not_needed", "expired"] as const)
                      .filter((k) => (q.data?.closedToday[k] ?? 0) > 0)
                      .map((k) => t(`queue.closed.${k}`, { count: q.data?.closedToday[k] ?? 0 }))
                      .join(" · ")}
                  </p>
                  {closedRows.map((r) => (
                    <ClosedTurnRow key={r.followUpId} row={r} tz={tz} />
                  ))}
                </div>
              </ClosedFold>
            </section>
          ) : null}
        </div>
        {showDetail && sel ? (
          <QueueDetail
            item={sel}
            now={now}
            tz={tz}
            today={today}
            onClose={() => setDetailOpen(false)}
          />
        ) : null}
        {openWith.menu}
        {host.node}
        <BulkBar keys={multi.map((id) => `turn:${id}`)} onClear={() => setMulti([])} />
        {prompt ? (
          <PromptView
            prompt={prompt}
            today={q.data?.today ?? ""}
            onClose={() => setPrompt(null)}
            onCreate={() => {}}
          />
        ) : null}
      </div>
    </ItemActionsProvider>
  );
}

const PRIMARY_KEY: Record<string, MessageKey> = {
  approve: "ai.primary.permit",
  reply: "ai.primary.reply",
  answer: "ai.primary.answer",
  resume_error: "ai.primary.resume",
  resume_limit: "ai.primary.resume",
  review_pr: "ai.primary.pr",
  merge_pr: "ai.primary.pr",
  check_changes: "ai.primary.check",
};

const KIND_KEY: Record<string, MessageKey> = {
  approve: "queue.kind.approve",
  reply: "queue.kind.reply",
  review_pr: "queue.kind.review_pr",
  resume_error: "queue.kind.resume_error",
  resume_limit: "queue.kind.resume_limit",
  check_changes: "queue.kind.check_changes",
  merge_pr: "queue.kind.merge_pr",
};

/**
 * 自分の番の詳細（380px。確定デザイン）: 件名、状態（アイコンと言葉）、リポジトリ · ブランチ、待っている理由（表示の瞬間に読む
 * 中身。D-207）、操作（開いて対応 / 移動 / スヌーズ ▾ / 対応不要。対応不要は同じ行の右端の文字のボタン。自分の番のレビューの
 * 「実装で直すこと」2）、PR、この項目の流れ（AI の詳細パネルと共通。D-116）。中身は保存しない
 */
function QueueDetail({
  item: raw,
  now,
  tz,
  today,
  onClose,
}: {
  item: QueueItem;
  now: number;
  tz: string;
  today: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  // 後での行（スヌーズ中・明日へ・上限待ち）は、件名と理由を普通の行と同じ関数で作る（スヌーズ中を open として見る）
  const later = isLater(raw);
  const item = later ? laterViewItem(raw) : raw;
  const d = useWorkItem(item.workItemId).data;
  const fu = later ? laterFollowUp(raw) : primaryFollowUp(item);
  const grace = isGrace(item);
  const status =
    !grace && (item.status === "needs_input" || item.status === "error")
      ? item.status
      : "your_turn";
  // 件名と待っている理由（表示の瞬間に読む。D-207、spec-glance §3.7）
  const glance = useGlance(item);
  const view = turnView(item, glance, locale);
  const title = view.subject || (fu ? titleOf(fu.title, locale) : (item.title ?? t("common.none")));
  const pr = d?.artifacts.find((a) => a.kind === "pr") ?? null;
  // 確認支援（差分の量・テスト・CI。D-109）
  const check = useCheck({ workItemId: item.workItemId }).data;
  const checks = hasCheckRows(check) ? check : undefined;
  const run = (id: string) => () => dispatchKey(id);
  // 主ボタンは待ちの種類に合わせる（ボードの詳細と同じ言葉。D-214 の §4）
  const primaryKey: MessageKey =
    PRIMARY_KEY[view.parts.why ?? ""] ?? ("menu.openTurn" as MessageKey);
  // Turnlane から答える（D-238）。答えている間は主ボタンを節の「送る」に譲る
  const canAnswer = useAnswerEnabled() && !later && answerable(item);
  const answering = useAnswerOpen(item.workItemId) && canAnswer;
  return (
    <ResizablePanel
      className="flex flex-col gap-5 overflow-y-auto border-line border-l px-5 py-6"
      testId="queue-detail"
      label={title}
    >
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 font-semibold text-fg text-section">{title}</h2>
        <button
          type="button"
          aria-label={t("action.close")}
          onClick={onClose}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg"
        >
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="-mt-3 flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-body text-fg">
          <StatusIcon status={status} estimated={item.estimated} size={16} title={false} />
          {t(`status.${status}`)}
          {/* 待ちの種類は行と同じ言葉（AskUserQuestion は回答待ち。D-214 の §4） */}
          {view.parts.why ? (
            <span className="text-fg2">· {t(`turn.why.${view.parts.why}`)}</span>
          ) : fu && KIND_KEY[fu.limit ? "resume_limit" : fu.kind] ? (
            <span className="text-fg2">
              · {t(KIND_KEY[fu.limit ? "resume_limit" : fu.kind] as MessageKey)}
            </span>
          ) : null}
          {later ? (
            <span className="text-fg3" data-testid="queue-detail-later">
              · {laterLabel(raw, today, now, tz, t)}
            </span>
          ) : null}
          {item.grace && grace ? (
            <span className="text-fg3" data-testid="queue-detail-grace">
              · {t("turn.grace", { time: fmtWait(Math.max(0, item.grace.until - now)) })}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-fg2 text-meta">
          {[whereName(item, t("ai.scratch")), item.branch].filter(Boolean).join(" · ")}
          <SquareTerminal size={14} strokeWidth={1.5} aria-hidden="true" />
        </span>
      </div>
      {!(answering && fu?.kind !== "approve") ? (
        <WhyBlock view={view} prompt={glance?.prompt?.text} />
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="queue-detail-actions">
        <Button
          variant={answering ? "secondary" : "primary"}
          className="px-2"
          onClick={() =>
            void openTask(fu ? { followUpId: fu.id } : { workItemId: item.workItemId })
          }
          title={`${t(primaryKey)} · ${keyHint("open")}`}
        >
          {t(primaryKey)}
          <span className="font-mono text-micro opacity-70">{keyHint("open")}</span>
        </Button>
        {canAnswer && !answering ? (
          <Button
            className="px-2"
            onClick={() => openAnswer(item.workItemId)}
            title={`${t("answer.action")} · ${keyHint("answer")}`}
            data-testid="queue-answer"
          >
            {t("answer.action")}
            <span className="font-mono text-micro opacity-70">{keyHint("answer")}</span>
          </Button>
        ) : null}
        {/* 後での行: 今やる（スヌーズ解除。上限待ちには無い）と 対応不要 だけ */}
        {later ? (
          <>
            {fu ? (
              <Button className="px-2" onClick={run("wake")} data-testid="queue-wake">
                {t("queue.later.wake")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="ml-auto px-1"
              onClick={run("dismiss")}
              title={`${t("menu.dismiss")} · ${keyHint("dismiss")}`}
            >
              {t("menu.dismiss")}
            </Button>
          </>
        ) : null}
        {/* 猶予中の問い（D-245）は返答タスクが無いので 明日へ・スヌーズ・対応不要 を出さない */}
        {grace || later ? null : (
          <>
            <Button
              className="px-2"
              onClick={run("move")}
              title={`${t("menu.tomorrow")} · ${keyHint("move")}`}
            >
              {t("menu.tomorrow")}
            </Button>
            <Button
              className="px-2"
              onClick={run("snooze")}
              title={`${t("menu.snooze")} · ${keyHint("snooze")}`}
            >
              {t("queue.snooze")}
              <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              className="ml-auto px-1"
              onClick={run("dismiss")}
              title={`${t("menu.dismiss")} · ${keyHint("dismiss")}`}
            >
              {t("menu.dismiss")}
            </Button>
          </>
        )}
      </div>
      {canAnswer ? <AnswerSection workItemId={item.workItemId} wait={item.wait} /> : null}
      {pr || checks ? (
        <section
          className="flex flex-col gap-2 border-line border-t pt-4"
          data-testid="queue-result"
        >
          <h3 className="font-semibold text-fg2 text-meta">
            {pr ? t("queue.pr") : t("ai.result")}
          </h3>
          {pr ? (
            <a
              href={pr.url ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 rounded-card border border-line px-3 py-2 text-body hover:border-fg3"
            >
              <GitPullRequest
                size={16}
                strokeWidth={1.5}
                className="shrink-0 text-fg2"
                aria-hidden="true"
              />
              <span className="shrink-0 font-medium">{prLabel(pr.ref)}</span>
              <span className="min-w-0 flex-1 truncate">{pr.title}</span>
              {prStateKey(pr) ? (
                <span className="shrink-0 text-fg2 text-meta">
                  {t(prStateKey(pr) as MessageKey)}
                </span>
              ) : null}
            </a>
          ) : null}
          {checks ? <CheckRows c={checks} /> : null}
        </section>
      ) : null}
      {/* この項目の流れ（AI の詳細パネルと共通の部品。項目全体を時刻順に、古い区間は畳む。会議の区間は「会議中」。D-116） */}
      {d ? <FlowSection detail={d} now={now} tz={tz} /> : null}
    </ResizablePanel>
  );
}

function titleOf(x: Parameters<typeof titleText>[0], locale: "en" | "ja"): string {
  return titleText(x, locale);
}
