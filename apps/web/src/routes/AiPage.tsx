/**
 * AI の画面（ux-mvp 4.19）: いま生きている AI 項目（リポジトリ × ブランチ。ボードのカードと同じ単位）の全部を節に
 * 1 行ずつ: 自分の番 → 後で → 動いている → 止まっている → 片付けが残っている → プロセスが残っている（最後の動きが 1 日より
 * 前でプロセスが残っているだけのもの。既定で畳んだ 1 行）。1 つの項目はこの画面の 1 か所にだけ出し、上の節が勝つ（core の
 * liveSections）。上の 2 節は自分の番の画面と同じデータ・同じ順・同じ件数（GET /api/queue）。下の節は GET /api/ai/live。
 *
 * 操作は既存のものだけ: ⏎ 開いて対応 / 開く、o 他の開き方、a 答える、e 対応不要（自分の番・後で）、Space 完了（自分の番）・
 * 片付け（片付けの節。タスクが未完了なら完了のシート、完了済みなら片付けだけのシート）、1 クリックで AI 詳細パネル、j / k
 * （節をまたぐ。閉じた節は飛ばす）。節の開閉はブラウザに覚える（プロセスが残っているの節だけ既定で畳む）。帯・メニューバー・
 * 通知・件数は変えない
 */
import { Link } from "@tanstack/react-router";
import {
  type LiveItem,
  liveSections,
  type QueueItem,
  type TaskDetailResponse,
} from "@turnlane/core/web";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ItemActionsProvider, useItemActionsHost } from "../actions/item-actions.tsx";
import {
  AiRow,
  type AiRowData,
  type AiSection,
  type LiveSection,
  liveOf,
  queueOf,
  rowFollowUp,
} from "../components/AiRow.tsx";
import { openAnswer } from "../components/AnswerSection.tsx";
import { useOpenWith } from "../components/OpenWith.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import {
  completeItems,
  dismissFollowUps,
  dismissLimitWait,
  openTask,
  wakeFollowUp,
} from "../data/mutations.ts";
import { useAiLive, useQueue, useSources } from "../data/queries.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { useKeys } from "../keys/use-keys.ts";
import { prepareCleanup } from "../launch/finish.ts";
import { api, unwrap } from "../lib/api.ts";
import { useNow } from "../lib/clock.ts";
import { usePanelsAvailable } from "../lib/panels.ts";
import { type SelItem, setUi } from "../lib/store.ts";
import { usePublishSelection } from "../palette/selection.ts";

const SECTIONS: AiSection[] = ["turn", "later", "running", "stopped", "cleanup", "stale"];
/** これを超えたら先頭だけ出して「ほか N 件 ▸」（止まっている・片付け・プロセスが残っている。ほかの節は全件） */
const FOLD_AFTER = 10;
const FOLDABLE = new Set<AiSection>(["stopped", "cleanup", "stale"]);
/** 既定で畳む節（開いたら覚える） */
const CLOSED_BY_DEFAULT: AiSection[] = ["stale"];

/**
 * 節の開閉（既定は「プロセスが残っている」だけ畳み、ほかは開く。ブラウザに覚える）。閉じた節は CLOSED_KEY、既定で畳む節を
 * 開いたものは OPENED_KEY に入れる
 */
const CLOSED_KEY = "turnlane.aiClosed";
const OPENED_KEY = "turnlane.aiOpened";
function readList(key: string): AiSection[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is AiSection => SECTIONS.includes(x)) : [];
  } catch {
    return [];
  }
}
function readClosed(): AiSection[] {
  const opened = readList(OPENED_KEY);
  const closed = readList(CLOSED_KEY);
  return [
    ...closed,
    ...CLOSED_BY_DEFAULT.filter((s) => !opened.includes(s) && !closed.includes(s)),
  ];
}
function writeClosed(v: AiSection[]): void {
  try {
    localStorage.setItem(
      CLOSED_KEY,
      JSON.stringify(v.filter((s) => !CLOSED_BY_DEFAULT.includes(s))),
    );
    localStorage.setItem(
      OPENED_KEY,
      JSON.stringify(CLOSED_BY_DEFAULT.filter((s) => !v.includes(s))),
    );
  } catch {
    // 保存できなくても開閉はできる
  }
}

function rowsOf(s: ReturnType<typeof liveSections>): Record<AiSection, AiRowData[]> {
  const q = (section: "turn" | "later") => (item: QueueItem) => ({
    section,
    id: item.workItemId,
    key: `turn:${item.workItemId}`,
    item,
  });
  const l = (section: LiveSection) => (live: LiveItem) => ({
    section,
    id: live.id,
    key: `ai:${live.id}`,
    live,
  });
  return {
    turn: s.turn.map(q("turn")),
    later: s.later.map(q("later")),
    running: s.running.map(l("running")),
    stopped: s.stopped.map(l("stopped")),
    cleanup: s.cleanup.map(l("cleanup")),
    stale: s.stale.map(l("stale")),
  };
}

/** 上部バーの題名の右（`動いている 3 · 止まっている 2`）。自分の番の数は上部バーの右に既にあるので繰り返さない */
export function useAiSummary(): string {
  const { t } = useI18n();
  const q = useQueue();
  const live = useAiLive();
  const now = useNow();
  const s = liveSections(q.data, live.data?.items, now);
  return [
    s.running.length > 0 ? t("ai.live.running", { count: s.running.length }) : "",
    s.stopped.length > 0 ? t("ai.live.stopped", { count: s.stopped.length }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 片付けの節の Space: タスクが未完了なら完了のシート（完了 / 片付けずに完了）、完了済みなら片付けだけのシート */
async function cleanupRow(x: LiveItem): Promise<void> {
  const l = x.launch;
  if (!l) return;
  if (!l.taskDone) {
    try {
      const d = await unwrap<TaskDetailResponse>(
        api.api.tasks[":id"].$get({ param: { id: l.taskId } }),
      );
      if (d.task.status !== "done") {
        await completeItems([d.task], []);
        return;
      }
    } catch {
      // タスクが読めなければ片付けだけ
    }
  }
  await prepareCleanup(l.taskId);
}

export function AiPage() {
  const { t } = useI18n();
  const q = useQueue();
  const live = useAiLive();
  const sources = useSources();
  const now = useNow();
  const tz = q.data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = q.data?.today ?? "";
  const sections = liveSections(q.data, live.data?.items, now);
  const all = rowsOf(sections);
  const [closed, setClosed] = useState<AiSection[]>(readClosed);
  const [expanded, setExpanded] = useState<AiSection[]>([]);
  const shown = (s: AiSection): AiRowData[] => {
    const xs = all[s];
    return FOLDABLE.has(s) && !expanded.includes(s) && xs.length > FOLD_AFTER
      ? xs.slice(0, FOLD_AFTER)
      : xs;
  };
  // j / k で動く行（開いた節だけ）
  const rows = SECTIONS.flatMap((s) => (closed.includes(s) ? [] : shown(s)));
  const [curKey, setCurKey] = useState<string | null>(null);
  const curIndex = Math.max(
    0,
    rows.findIndex((r) => r.key === curKey),
  );
  const sel = rows.length > 0 ? rows[Math.min(curIndex, rows.length - 1)] : undefined;
  const panels = usePanelsAvailable();
  const answerOn = useAnswerEnabled();
  const openWith = useOpenWith();
  const select = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (r) setCurKey(r.key);
  };
  const anchor = () =>
    sel
      ? document.querySelector<HTMLElement>(`[data-kind="ai-row"][data-id="${CSS.escape(sel.id)}"]`)
      : null;
  const waitOf = (r: AiRowData) => queueOf(r) ?? liveOf(r);
  useKeys({
    next: () => {
      select(curIndex + 1);
      return true;
    },
    prev: () => {
      select(curIndex - 1);
      return true;
    },
    open: () => {
      if (!sel) return false;
      const f = rowFollowUp(sel);
      // 片付けの行は worktree のフォルダ（項目の作業場所）
      void openTask(
        f
          ? { followUpId: f.id }
          : sel.section === "cleanup"
            ? { workItemId: sel.id, action: "finder" }
            : { workItemId: sel.id },
      );
      return true;
    },
    openWith: () => {
      if (!sel || sel.section === "later") return false;
      const f = rowFollowUp(sel);
      openWith.show(anchor(), f ? { followUpId: f.id } : { workItemId: sel.id });
      return true;
    },
    answer: () => {
      if (!sel || sel.section === "later" || !answerOn || !answerable(waitOf(sel))) return false;
      if (sel.section === "cleanup") return false;
      setUi({ panelWorkItemId: sel.id });
      openAnswer(sel.id);
      return true;
    },
    dismiss: () => {
      if (!sel) return false;
      if (sel.section === "turn") {
        const f = rowFollowUp(sel);
        if (!f) return false;
        void dismissFollowUps([f.id]);
        return true;
      }
      if (sel.section === "later") {
        const f = rowFollowUp(sel);
        void (f ? dismissFollowUps([f.id]) : dismissLimitWait(sel.id));
        return true;
      }
      return false;
    },
    wake: () => {
      const f = sel?.section === "later" ? rowFollowUp(sel) : undefined;
      if (!f || !today) return false;
      void wakeFollowUp(f.id, today);
      return true;
    },
    complete: () => {
      if (!sel) return false;
      if (sel.section === "turn") {
        const f = rowFollowUp(sel);
        if (!f) return false;
        void completeItems([], [f.id]);
        return true;
      }
      const l = liveOf(sel);
      if (sel.section === "cleanup" && l) {
        void cleanupRow(l);
        return true;
      }
      return false;
    },
    detail: () => {
      if (!sel || !panels) return false;
      setUi({ panelWorkItemId: sel.id });
      return true;
    },
  });
  const selItem = (r: AiRowData): SelItem => {
    const item = queueOf(r);
    return item
      ? { kind: "turn", item }
      : { kind: "ai", id: r.id, title: liveOf(r)?.title ?? null };
  };
  // ⌘K（ux-mvp 6.1）: 選んでいる行をパレットに渡す
  usePublishSelection(sel ? [selItem(sel)] : []);
  // マウス: 1 クリックで選んで AI 詳細パネル、ダブルクリックで開く、右クリック・ホバーのボタン
  const host = useItemActionsHost({
    select: (k) => setCurKey(k),
    inMulti: () => false,
    itemsFor: (k) => rows.filter((r) => r.key === k).map(selItem),
  });
  const toggle = (s: AiSection) => {
    const next = closed.includes(s) ? closed.filter((x) => x !== s) : [...closed, s];
    setClosed(next);
    writeClosed(next);
  };
  const total = SECTIONS.reduce((n, s) => n + all[s].length, 0);
  const loaded = q.isSuccess && live.isSuccess;
  const noSources = sources.isSuccess && sources.data.sources.length === 0;
  const laterLimits = sections.later.filter((x) => x.limitWait).length;
  const head = (s: AiSection): ReactNode => {
    const n = all[s].length;
    const hint = [
      t(`ai.live.time.${s}` as MessageKey),
      s === "stopped" && all.stopped.some((r) => liveOf(r)?.process === "unknown")
        ? t("ai.live.estimatedHint")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return (
      <div className="flex h-7 items-center gap-3">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => toggle(s)}
          aria-expanded={!closed.includes(s)}
          title={hint}
          data-testid="ai-section-head"
          className="flex h-7 items-center gap-1.5 rounded-control px-1 text-fg2 text-meta hover:text-fg"
        >
          <ChevronRight
            size={14}
            strokeWidth={1.5}
            aria-hidden="true"
            className={closed.includes(s) ? "" : "rotate-90"}
          />
          <span className="whitespace-nowrap">
            {t(`ai.live.${s}` as MessageKey, { count: n })}
            {s === "stale" ? (
              // 幅が足りなければ括弧の中は出さない（1 行に収める）
              <span className="hidden @min-[480px]:inline">{t("ai.live.staleWhy")}</span>
            ) : null}
          </span>
        </button>
        {s === "later" && laterLimits > 0 ? (
          <span className="text-fg3 text-meta" data-testid="ai-later-limit">
            {t("ai.live.laterLimit", { count: laterLimits })}
          </span>
        ) : null}
        {s === "turn" ? (
          <Link
            to="/queue"
            className="ml-auto text-fg2 text-meta hover:text-fg"
            data-testid="ai-open-queue"
          >
            {t("ai.live.openQueue")}{" "}
            <span className="font-mono text-fg3">{keyHint("goQueue")}</span>
          </Link>
        ) : null}
      </div>
    );
  };
  return (
    <ItemActionsProvider value={host.api}>
      <div
        className="@container flex h-full min-w-0 flex-col gap-4 overflow-y-auto px-4 py-6 sm:px-8"
        data-testid="ai-page"
      >
        {loaded && total === 0 ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-2 pb-24 text-center"
            data-testid="ai-empty"
          >
            {noSources ? (
              <p className="text-body text-fg2">
                {t("ai.live.noSources")}{" "}
                <Link to="/settings" hash="ai" className="text-fg underline">
                  {t("ai.live.noSourcesLink")}
                </Link>
              </p>
            ) : (
              <>
                <p className="font-semibold text-fg text-section">{t("ai.live.emptyTitle")}</p>
                <p className="text-body text-fg2">{t("ai.live.emptyHint")}</p>
              </>
            )}
          </div>
        ) : null}
        {SECTIONS.filter((s) => all[s].length > 0).map((s) => {
          const xs = shown(s);
          const rest = all[s].length - xs.length;
          return (
            <section
              key={s}
              className="flex flex-col gap-0.5"
              data-testid="ai-section"
              data-section={s}
            >
              {head(s)}
              {closed.includes(s)
                ? null
                : xs.map((r) => (
                    <AiRow
                      key={r.key}
                      row={r}
                      now={now}
                      tz={tz}
                      today={today}
                      selected={sel?.key === r.key}
                    />
                  ))}
              {!closed.includes(s) && rest > 0 ? (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setExpanded((e) => [...e, s])}
                  className="flex h-7 items-center gap-1 self-start rounded-control px-3 text-fg2 text-meta hover:text-fg"
                  data-testid="ai-more"
                >
                  {t("ai.live.more", { count: rest })}
                  <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
                </button>
              ) : null}
            </section>
          );
        })}
        {openWith.menu}
        {host.node}
      </div>
    </ItemActionsProvider>
  );
}
