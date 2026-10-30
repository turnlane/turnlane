/**
 * タスクの詳細パネル（S6b。D-070。ux-mvp 4.12。タスクのパネルのレビュー v1 で AI の詳細パネル D-116 と同じ作りにした）:
 * 1. 頭: ○（完了）・大きな題名（その場で編集）・×
 * 2. 状態の1行（「Inbox · 1h」「今日 14:00–15:00 · 1h」「10/12（月） · 30m」「完了 · 15:20」）と主のボタン1つ
 *    （日に置く ▾ / 時間を置く / AI に頼む / 開く。task-state.ts）、行の右端に「⋯」（右クリックのメニューと同じ並び。
 *    AI の詳細パネルと同じ位置）
 * 3. 属性: 日付・時間（日付があるときだけ）・見積・プロジェクト・持ち越し・経由。値は枠のない文字のボタンで、押すとメニューや
 *    ポップオーバー（日付は m の入力、見積は候補と任意、プロジェクトは色の点の一覧、時間は開始と長さ）
 * 4. 頼んだ AI（D-107）、拡張の節（ADR 0015）、メモ（この Mac の DB にだけ保存。欄を離れたら保存）
 * 書き込みは画面のキーと同じ処理（mutations.ts）を通す。OS の select と数字の入力欄は使わない
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fmtClock,
  fmtClock2,
  fmtDuration,
  type LaunchCandidate,
  nextWeekday,
  type TaskAiView,
  type TaskDetailResponse,
  type TaskView,
  type TimeBlockView,
  wallClock,
  wallToEpoch,
} from "@turnlane/core/web";
import {
  ArrowRight,
  ArrowRightToLine,
  CalendarDays,
  ChevronDown,
  ExternalLink,
  Inbox,
  Pencil,
  SquareTerminal,
  Sun,
  Sunrise,
} from "lucide-react";
import { type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MENU_ICON, menuSpec } from "../actions/item-actions.tsx";
import { PromptView } from "../board/editors.tsx";
import { AutoGrowTextarea } from "../components/AutoGrowTextarea.tsx";
import { ContextMenu, type MenuEntry } from "../components/ContextMenu.tsx";
import { Carry, titleText, viaLabel } from "../components/items.tsx";
import { Button, Check, Popover } from "../components/ui.tsx";
import { keys } from "../data/invalidate.ts";
import {
  deleteTask,
  linkLaunch,
  moveTask,
  openTask,
  renameTask,
  scheduleTask,
  setComplete,
  unscheduleTask,
} from "../data/mutations.ts";
import { useProjects } from "../data/queries.ts";
import { ext } from "../ext/registry.ts";
import { type AnyMessageKey, useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { AskAiPopover } from "../launch/AskAi.tsx";
import { CheckRows, hasCheckRows, useCheck } from "../launch/CheckRows.tsx";
import { TaskAiLine } from "../launch/TaskAiLine.tsx";
import { api, unwrap } from "../lib/api.ts";
import { addDaysSafe } from "../lib/dates.ts";
import { isImeKey, readAfterComposition } from "../lib/ime.ts";
import { openInApp } from "../lib/open.ts";
import { setUi, toast, useUi } from "../lib/store.ts";
import {
  ActionButton,
  Field,
  MoreButton,
  PanelFrame,
  PanelHead,
  PanelSection,
  ValueButton,
} from "./PanelFrame.tsx";
import {
  ESTIMATE_PRESETS,
  LENGTH_PRESETS,
  parseEstimate,
  type TaskHead,
  taskHeadOf,
  taskPrimaryOf,
} from "./task-state.ts";

const MIN = 60_000;

/** その日（暦日）の HH:MM → epoch ms */
export function atLocal(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return wallToEpoch(y, m, d, minutes, tz);
}

/** "9:30" / "09:30" / "930" → 分。読めなければ null */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? h * 60 + mm : null;
}

export function useTaskDetail(id: string | null) {
  return useQuery({
    queryKey: keys.task(id ?? ""),
    queryFn: () =>
      unwrap<TaskDetailResponse>(api.api.tasks[":id"].$get({ param: { id: id ?? "" } })),
    enabled: id !== null,
    retry: false,
  });
}

const closePanel = () => setUi({ panelTaskId: null });

export function TaskPanel() {
  const id = useUi((s) => s.panelTaskId);
  const { t } = useI18n();
  const q = useTaskDetail(id);
  if (!id) return null;
  return (
    <PanelFrame label={t("taskPanel.title")} testId="task-panel" variant="detail">
      {!q.data ? (
        <>
          <PanelHead title={t("taskPanel.title")} onClose={closePanel} />
          <div className="text-body text-fg3">
            {q.isError ? t("taskPanel.notFound") : t("common.loading")}
          </div>
        </>
      ) : (
        <TaskBody d={q.data} />
      )}
    </PanelFrame>
  );
}

type Menu = { x: number; y: number; entries: MenuEntry[] };
/** 開いているポップオーバー（日付の入力・見積の任意・時間・AI に頼む） */
type Pop = { kind: "date" | "estimate" | "time" | "ai"; anchor: HTMLElement };

/** メニューの置き場所（要素の下。右寄せはメニューの幅 240px） */
function below(el: HTMLElement, alignRight = false): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right - 240 : r.left, y: r.bottom + 4 };
}

function TaskBody({ d }: { d: TaskDetailResponse }) {
  const { t, locale, shortDate } = useI18n();
  const qc = useQueryClient();
  const projects = useProjects().data ?? [];
  const task = d.task;
  const today = d.today;
  const tomorrow = addDaysSafe(today, 1);
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.task(task.id) });
  const run = (p: Promise<unknown>) => void p.finally(refresh);
  const patch = (json: {
    notes?: string | null;
    estimateMin?: number | null;
    projectId?: string | null;
  }) =>
    run(
      unwrap(api.api.tasks[":id"].$patch({ param: { id: task.id }, json })).catch(() =>
        toast(t("toast.saveFailed")),
      ),
    );
  const done = task.status === "done";
  const block = d.blocks[0] ?? null;
  const head = taskHeadOf(task, block, today, tomorrow);
  // 拡張が作ったタスクの出どころ（ExtTaskOrigin）。primary があれば主ボタンはそれ（D-192 §5.4 (3)）
  const extOrigin = task.origin.externalSource
    ? ext.taskOrigins.get(task.origin.externalSource.toLowerCase())
    : undefined;
  const extPrimary = extOrigin?.primary && extOrigin.to ? extOrigin : null;
  const primary = taskPrimaryOf(task, block !== null, extPrimary !== null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const project = projects.find((p) => p.id === task.projectId) ?? null;

  /** 時間に置く（⌘K の空き枠の候補。`p` と同じ） */
  const placeTime = () => setUi({ selection: [{ kind: "task", task }], palette: "place" });

  // ---------- メニューの中身 ----------
  const dateEntries = (anchor: HTMLElement): MenuEntry[] => {
    const next = nextWeekday(today);
    const to = (date: string | null) => () => run(moveTask(task, date));
    const out: MenuEntry[] = [
      {
        id: "d-today",
        label: t("taskPanel.date.today"),
        icon: Sun,
        keys: shortDate(today),
        checked: task.scheduledDate === today ? true : undefined,
        run: to(today),
      },
      {
        id: "d-tomorrow",
        label: t("taskPanel.date.tomorrow"),
        icon: Sunrise,
        keys: shortDate(tomorrow),
        checked: task.scheduledDate === tomorrow ? true : undefined,
        run: to(tomorrow),
      },
    ];
    if (next !== tomorrow)
      out.push({
        id: "d-next",
        label: t("taskPanel.date.nextWorkday"),
        icon: ArrowRightToLine,
        keys: shortDate(next),
        checked: task.scheduledDate === next ? true : undefined,
        run: to(next),
      });
    out.push({
      id: "d-pick",
      label: t("menu.move"),
      icon: CalendarDays,
      keys: keyHint("move"),
      run: () => setPop({ kind: "date", anchor }),
    });
    if (task.scheduledDate)
      out.push({
        id: "d-inbox",
        label: t("taskPanel.toInbox"),
        icon: Inbox,
        sep: true,
        run: to(null),
      });
    return out;
  };
  const estimateEntries = (anchor: HTMLElement): MenuEntry[] => [
    ...ESTIMATE_PRESETS.map(
      (m): MenuEntry => ({
        id: `e-${m}`,
        label: fmtDuration(m * MIN),
        checked: task.estimateMin === m,
        run: () => patch({ estimateMin: m }),
      }),
    ),
    {
      id: "e-custom",
      label: t("taskPanel.estimate.custom"),
      icon: Pencil,
      sep: true,
      checked:
        task.estimateMin !== null &&
        !(ESTIMATE_PRESETS as readonly number[]).includes(task.estimateMin)
          ? true
          : undefined,
      keys:
        task.estimateMin !== null &&
        !(ESTIMATE_PRESETS as readonly number[]).includes(task.estimateMin)
          ? fmtDuration(task.estimateMin * MIN)
          : undefined,
      run: () => setPop({ kind: "estimate", anchor }),
    },
    {
      id: "e-none",
      label: t("taskPanel.none"),
      checked: task.estimateMin === null,
      run: () => patch({ estimateMin: null }),
    },
  ];
  const projectEntries = (): MenuEntry[] => [
    ...projects.map(
      (p): MenuEntry => ({
        id: `p-${p.id}`,
        label: p.name,
        swatch: p.color,
        checked: task.projectId === p.id,
        run: () => patch({ projectId: p.id }),
      }),
    ),
    {
      id: "p-none",
      label: t("taskPanel.none"),
      sep: projects.length > 0,
      checked: task.projectId === null,
      run: () => patch({ projectId: null }),
    },
  ];
  /** 「⋯」: 右クリックのメニューと同じ並び（menuSpec。詳細を開くは除く）を、このタスクに直接効かせる */
  const moreEntries = (anchor: HTMLElement): MenuEntry[] =>
    menuSpec([{ kind: "task", task }], { placed: block !== null })
      .filter((s) => s.id !== "detail")
      .map((s) => ({
        id: s.id,
        label: t(s.label),
        keys: s.keyId ? keyHint(s.keyId) || undefined : undefined,
        danger: s.danger,
        sep: s.sep,
        icon: MENU_ICON[s.id],
        run: () => {
          const a = s.action;
          if (a.t === "askAi") return setPop({ kind: "ai", anchor });
          if (a.t === "ext") {
            const item = ext.taskMenuItems.find((x) => x.key === a.key);
            item?.run(task, anchor);
            return;
          }
          if (a.t !== "key") return;
          switch (a.id) {
            case "complete":
              return run(setComplete(task, !done));
            case "today":
              return run(moveTask(task, today));
            case "later":
              return run(moveTask(task, addDaysSafe(task.scheduledDate ?? today, 1)));
            case "move":
              return setPop({ kind: "date", anchor });
            case "place":
              return placeTime();
            case "rename":
              titleRef.current?.focus();
              titleRef.current?.select();
              return;
            case "unblock":
              return run(unscheduleTask(task));
            case "delete":
              closePanel();
              void deleteTask(task);
              return;
          }
        },
      }));

  const open = (el: HTMLElement, entries: MenuEntry[], alignRight = false) =>
    setMenu({ ...below(el, alignRight), entries });

  return (
    <>
      <PanelHead
        onClose={closePanel}
        lead={
          <span className="flex h-7 shrink-0 items-center">
            <Check
              checked={done}
              onToggle={() => run(setComplete(task, !done))}
              label={t("taskPanel.complete")}
            />
          </span>
        }
        title={
          <TitleInput
            value={titleText(task.title, locale)}
            onCommit={(v) => run(renameTask(task, v))}
            inputRef={titleRef}
            size="head"
          />
        }
      />
      <div className="-mt-3 flex flex-col gap-2.5">
        <StateLine head={head} tz={d.tz} />
        <Actions
          task={task}
          primary={primary}
          extPrimary={extPrimary}
          onPlaceDate={(el) => open(el, dateEntries(el))}
          onPlaceTime={placeTime}
          onAskAi={(el) => setPop({ kind: "ai", anchor: el })}
          onMore={(el) => open(el, moreEntries(el), true)}
        />
      </div>

      <section
        className="flex flex-col gap-0.5 border-line border-t pt-4"
        data-testid="task-fields"
      >
        <Field label={t("taskPanel.date")}>
          <ValueButton
            testId="task-date"
            onClick={(el) => open(el, dateEntries(el))}
            empty={!task.scheduledDate}
          >
            {task.scheduledDate ? shortDate(task.scheduledDate) : t("task.inbox")}
          </ValueButton>
        </Field>
        {/* 時間は日付があるときだけ（使えない欄は出さない） */}
        {task.scheduledDate ? (
          <Field label={t("taskPanel.time")}>
            <ValueButton
              testId="task-time"
              mono={block !== null}
              empty={block === null}
              onClick={(el) => setPop({ kind: "time", anchor: el })}
            >
              {block
                ? `${fmtClock(block.start, d.tz)}–${fmtClock(block.end, d.tz)}`
                : t("taskPanel.time.none")}
            </ValueButton>
          </Field>
        ) : null}
        <Field label={t("taskPanel.estimate")}>
          <ValueButton
            testId="task-estimate"
            mono={task.estimateMin !== null}
            empty={task.estimateMin === null}
            onClick={(el) => open(el, estimateEntries(el))}
          >
            {task.estimateMin !== null ? fmtDuration(task.estimateMin * MIN) : t("taskPanel.none")}
          </ValueButton>
        </Field>
        <Field label={t("taskPanel.project")}>
          <ValueButton
            testId="task-project"
            empty={!project}
            onClick={(el) => open(el, projectEntries())}
          >
            {project ? (
              <>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: project.color ?? "var(--dl-text-3)" }}
                  aria-hidden="true"
                />
                <span className="truncate">{project.name}</span>
              </>
            ) : (
              t("taskPanel.none")
            )}
          </ValueButton>
        </Field>
        {task.rolloverCount > 0 ? (
          <Field label={t("taskPanel.carried")}>
            <Carry n={task.rolloverCount} />
          </Field>
        ) : null}
        <Field label={t("taskPanel.via")}>
          <Via task={task} />
        </Field>
      </section>

      {task.ai ? <TaskAiSection task={task} ai={task.ai} primary={primary} /> : null}

      {/* 拡張の節（ADR 0015。公開のビルドでは無い） */}
      {ext.panelSections.map((x) => (
        <section key={x.key} className="flex flex-col gap-1.5" data-ext-section={x.key}>
          <x.component task={task} />
        </section>
      ))}

      <NotesInput value={d.notes} onCommit={(v) => patch({ notes: v })} />

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      ) : null}
      {pop?.kind === "date" ? (
        <PromptView
          prompt={{
            kind: "move",
            anchor: pop.anchor,
            onSubmit: (date) => {
              if (date !== task.scheduledDate) run(moveTask(task, date));
            },
          }}
          today={today}
          onClose={() => setPop(null)}
          onCreate={() => undefined}
        />
      ) : null}
      {pop?.kind === "estimate" ? (
        <EstimatePrompt
          anchor={pop.anchor}
          value={task.estimateMin}
          onClose={() => setPop(null)}
          onSubmit={(m) => patch({ estimateMin: m })}
        />
      ) : null}
      {pop?.kind === "time" && task.scheduledDate ? (
        <TimePrompt
          anchor={pop.anchor}
          date={task.scheduledDate}
          block={block}
          estimateMin={task.estimateMin}
          tz={d.tz}
          onClose={() => setPop(null)}
          onPlace={(start, end) =>
            run(scheduleTask(task, task.scheduledDate as string, { start, end }))
          }
          onRemove={() => run(unscheduleTask(task))}
          onFree={placeTime}
        />
      ) : null}
      {pop?.kind === "ai" ? (
        <AskAiPopover task={task} anchor={pop.anchor} onClose={() => setPop(null)} />
      ) : null}
    </>
  );
}

/** 状態の1行（AI の詳細パネルの「自分の番 · 返答待ち · 3h6m」と同じ作り。時刻・長さは等幅） */
function StateLine({ head, tz }: { head: TaskHead; tz: string }) {
  const { t, shortDate } = useI18n();
  const p = head.place;
  const word =
    p.k === "done"
      ? t("taskPanel.state.done")
      : p.k === "inbox"
        ? t("task.inbox")
        : p.k === "today"
          ? t("taskPanel.date.today")
          : p.k === "tomorrow"
            ? t("taskPanel.date.tomorrow")
            : shortDate(p.date);
  // 置き場所の後ろ: 時刻（置いていれば）・長さ・完了の時刻。時刻と長さは等幅
  const rest: React.ReactNode[] = [];
  if (head.range)
    rest.push(
      <span key="r" className="font-mono">
        {fmtClock(head.range.start, tz)}–{fmtClock(head.range.end, tz)}
      </span>,
    );
  if (head.min !== null)
    rest.push(
      <span key="m">
        {rest.length > 0 ? " · " : "· "}
        <span className="font-mono">{fmtDuration(head.min * MIN)}</span>
      </span>,
    );
  if (p.k === "done" && p.at !== null)
    rest.push(
      <span key="d">
        {"· "}
        <span className="font-mono">{fmtClock(p.at, tz)}</span>
      </span>,
    );
  return (
    <div className="flex items-center gap-1.5 text-body" data-testid="task-state">
      <span className="shrink-0 font-medium text-fg">{word}</span>
      {rest.length > 0 ? <span className="min-w-0 truncate text-fg2">{rest}</span> : null}
    </div>
  );
}

/** 主のボタン1つと、並びのボタン（AI に頼む・AI の詳細）、右端の「⋯」 */
function Actions({
  task,
  primary,
  extPrimary,
  onPlaceDate,
  onPlaceTime,
  onAskAi,
  onMore,
}: {
  task: TaskView;
  primary: ReturnType<typeof taskPrimaryOf>;
  /** 拡張の出どころの主ボタン（文言と移る先。ExtTaskOrigin.primary） */
  extPrimary: { primary?: string | undefined; to?: string | undefined } | null;
  onPlaceDate: (el: HTMLElement) => void;
  onPlaceTime: () => void;
  onAskAi: (el: HTMLElement) => void;
  onMore: (el: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const done = task.status === "done" || task.status === "canceled";
  const askAi = !done && !task.ai;
  const buttons = [
    primary === "openTurn" ? (
      <ActionButton
        key="p"
        primary
        testId="task-primary"
        onClick={() => void openTask({ followUpId: task.followUpId as string })}
      >
        {t("taskPanel.openTurn")}
      </ActionButton>
    ) : primary === "extOrigin" && extPrimary ? (
      <ActionButton
        key="p"
        primary
        testId="task-primary"
        onClick={() => openInApp(extPrimary.to as string)}
      >
        {t(extPrimary.primary as AnyMessageKey)}
      </ActionButton>
    ) : primary === "placeDate" ? (
      <ActionButton
        key="p"
        primary
        testId="task-primary"
        onClick={(e) => onPlaceDate(e.currentTarget)}
        trail={<ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />}
      >
        {t("taskPanel.placeDate")}
      </ActionButton>
    ) : primary === "placeTime" ? (
      <ActionButton
        key="p"
        primary
        testId="task-primary"
        keys={keyHint("place") || undefined}
        onClick={onPlaceTime}
      >
        {t("taskPanel.placeTime")}
      </ActionButton>
    ) : primary === "askAi" ? (
      <ActionButton key="p" primary testId="task-primary" onClick={(e) => onAskAi(e.currentTarget)}>
        <SquareTerminal size={14} strokeWidth={1.5} aria-hidden="true" />
        {t("launch.title")}
      </ActionButton>
    ) : primary === "openAi" && task.ai?.workItemId ? (
      <ActionButton
        key="p"
        primary
        testId="task-primary"
        onClick={() => void openTask({ workItemId: task.ai?.workItemId as string })}
      >
        {t("launch.openSession")}
      </ActionButton>
    ) : null,
    askAi && primary !== "askAi" ? (
      <ActionButton key="ai" testId="task-ask-ai" onClick={(e) => onAskAi(e.currentTarget)}>
        <SquareTerminal size={14} strokeWidth={1.5} aria-hidden="true" />
        {t("launch.title")}
      </ActionButton>
    ) : null,
    // 自分の番のタスクの元の AI 項目（頼んだ AI が無いとき。D-059）
    !task.ai && task.workItemId ? (
      <ActionButton
        key="item"
        onClick={() => setUi({ panelWorkItemId: task.workItemId as string })}
      >
        {t("taskPanel.aiItem")}
      </ActionButton>
    ) : null,
  ].filter(Boolean);
  // 「⋯」は AI の詳細パネル（確定画像 Q1）と同じくボタンの行の右端。ボタンが無い（完了）ときも行に1つだけ置く
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5" data-testid="task-actions">
      {buttons}
      <MoreButton testId="task-more" className="ml-auto" onClick={(e) => onMore(e.currentTarget)} />
    </div>
  );
}

export function TitleInput({
  value,
  onCommit,
  inputRef,
  size = "body",
}: {
  value: string;
  onCommit: (v: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** head: 詳細パネルの頭の大きな題名（高さは中身に合わせる） */
  size?: "body" | "head";
}) {
  const { t } = useI18n();
  const [v, setV] = useState(value);
  const composing = useRef(false);
  const own = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setV(value), [value]);
  // 頭の題名は折り返した行の数だけ伸ばす
  // biome-ignore lint/correctness/useExhaustiveDependencies: 値が変わるたびに測り直す
  useLayoutEffect(() => {
    const el = own.current;
    if (size !== "head" || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [v, size]);
  // 保存する値は DOM から読む（変換の確定の直後に ⏎ / 欄を離れても、末尾の文字を落とさない）
  const commit = (raw: string) => {
    const next = raw.replace(/\n/g, "").trim();
    if (!next) setV(value);
    else if (next !== value) onCommit(next);
  };
  const setRef = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) inputRef.current = el;
  };
  return (
    <textarea
      ref={setRef}
      value={v}
      rows={size === "head" ? 1 : Math.min(3, Math.max(1, Math.ceil(v.length / 34)))}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onBlur={(e) => readAfterComposition(e.currentTarget, composing.current, commit)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isImeKey(e)) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      aria-label={t("task.renamePlaceholder")}
      data-testid="task-title"
      className={
        size === "head"
          ? "-mx-1 min-w-0 flex-1 resize-none overflow-hidden rounded-control border border-transparent bg-transparent px-1 py-0.5 font-semibold text-[18px] text-fg leading-6 outline-none hover:bg-sunken focus:border-line focus:bg-bg"
          : "min-w-0 flex-1 resize-none rounded-chip border border-transparent bg-transparent px-1 font-semibold text-section outline-none hover:border-line focus:border-accent"
      }
    />
  );
}

/** 見積の任意の入力（「45m」「1h30m」「90」。m の日付の入力と同じポップオーバー） */
function EstimatePrompt({
  anchor,
  value,
  onClose,
  onSubmit,
}: {
  anchor: HTMLElement;
  value: number | null;
  onClose: () => void;
  onSubmit: (min: number) => void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState(value !== null ? fmtDuration(value * MIN) : "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const parsed = v.trim() ? parseEstimate(v) : null;
  const submit = () => {
    const m = parseEstimate(input.current?.value ?? v);
    if (m === null) return;
    if (m !== value) onSubmit(m);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="w-[240px] p-3">
      <input
        ref={input}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("taskPanel.estimate.placeholder")}
        aria-label={t("taskPanel.estimate")}
        data-testid="estimate-input"
        className={`h-8 w-full rounded-card border bg-raised px-3 font-mono text-body outline-none placeholder:font-sans placeholder:text-fg3 ${v.trim() && parsed === null ? "border-error" : "border-line focus:border-[color-mix(in_srgb,var(--dl-text-3)_55%,var(--dl-border))]"}`}
        style={{ outline: "none" }}
      />
      {v.trim() ? (
        <div className="mt-2 text-fg2 text-meta">
          {parsed === null ? "?" : <span className="font-mono">{fmtDuration(parsed * MIN)}</span>}
        </div>
      ) : null}
    </Popover>
  );
}

/**
 * 時間（開始と長さ）。開始は時刻の入力、長さは候補から。空き時間の候補（⌘K の p）にも行ける（タスク）。
 * 予定の詳細パネルも同じポップオーバーで時刻を変える（onFree・onRemove なし）
 */
export function TimePrompt({
  anchor,
  date,
  block,
  estimateMin,
  tz,
  onClose,
  onPlace,
  onRemove,
  onFree,
  placeLabel,
}: {
  anchor: HTMLElement;
  date: string;
  block: Pick<TimeBlockView, "start" | "end"> | null;
  estimateMin: number | null;
  tz: string;
  onClose: () => void;
  onPlace: (start: number, end: number) => void;
  onRemove?: (() => void) | undefined;
  onFree?: (() => void) | undefined;
  /** 決めるボタンの文字（既定は「置く」） */
  placeLabel?: string | undefined;
}) {
  const { t } = useI18n();
  const cur = block ? Math.round((block.end - block.start) / MIN) : null;
  const [start, setStart] = useState(block ? fmtClock2(block.start, tz) : "");
  const [len, setLen] = useState<number>(cur ?? estimateMin ?? 30);
  const [err, setErr] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const lengths = [...new Set<number>([...LENGTH_PRESETS, ...(cur ? [cur] : []), len])].sort(
    (a, b) => a - b,
  );
  // 置いた日（日をまたいだブロックは開始の日）
  const day = block
    ? (() => {
        const w = wallClock(block.start, tz);
        return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
      })()
    : date;
  const submit = () => {
    const m = parseClock(input.current?.value ?? start);
    if (m === null) {
      setErr(true);
      return;
    }
    const s = atLocal(day, m, tz);
    if (!(block && s === block.start && len === cur)) onPlace(s, s + len * MIN);
    onClose();
  };
  const m = parseClock(start);
  const preview = m !== null ? atLocal(day, m, tz) : null;
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" className="w-[300px] p-3">
      <div className="flex items-center gap-2" data-testid="time-prompt">
        <input
          ref={input}
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            setErr(false);
          }}
          onKeyDown={(e) => {
            if (isImeKey(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="10:00"
          aria-label={t("taskPanel.start")}
          inputMode="numeric"
          data-testid="time-start"
          className={`h-8 w-20 rounded-card border bg-raised px-2 text-center font-mono text-body outline-none placeholder:text-fg3 ${err ? "border-error" : "border-line focus:border-[color-mix(in_srgb,var(--dl-text-3)_55%,var(--dl-border))]"}`}
          style={{ outline: "none" }}
        />
        <span className="font-mono text-fg2 text-meta">
          {preview !== null ? `– ${fmtClock(preview + len * MIN, tz)}` : ""}
        </span>
      </div>
      {/* 長さ（作成のポップオーバーの「タスク / 予定」と同じ切り替え） */}
      <div
        className="mt-2 flex gap-0.5 rounded-card bg-sunken p-0.5"
        role="radiogroup"
        aria-label={t("taskPanel.length")}
      >
        {lengths.map((x) => (
          // biome-ignore lint/a11y/useSemanticElements: 作成のポップオーバーの切り替えと同じ見た目のため button に role を付ける
          <button
            key={x}
            type="button"
            role="radio"
            aria-checked={len === x}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setLen(x)}
            className={`flex h-7 flex-1 items-center justify-center rounded-control font-medium font-mono text-meta ${len === x ? "bg-raised text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--dl-border)]" : "text-fg2 hover:text-fg"}`}
          >
            {fmtDuration(x * MIN)}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        {onFree ? (
          <Button
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose();
              onFree();
            }}
          >
            {t("taskPanel.time.free")}
          </Button>
        ) : null}
        {block && onRemove ? (
          <Button
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            {t("menu.unblock")}
          </Button>
        ) : null}
        <Button
          variant="primary"
          className="ml-auto"
          onMouseDown={(e) => e.preventDefault()}
          onClick={submit}
          data-testid="time-place"
        >
          {placeLabel ?? t("taskPanel.time.place")}
          <span className="font-mono text-micro opacity-70">{"↵"}</span>
        </Button>
      </div>
    </Popover>
  );
}

/** メモが自動で伸びる上限の行数（超えたら中でスクロール。つまみで手ならさらに広げられる） */
const NOTES_MAX_ROWS = 20;

/** メモ（小見出しの区切りの下の枠のない欄。フォーカスで薄い面。欄を離れたら保存。この Mac の DB にだけ。行数に合わせて伸びる） */
function NotesInput({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  return (
    <PanelSection title={t("taskPanel.notes")} testId="task-notes">
      <AutoGrowTextarea
        minRows={5}
        maxRows={NOTES_MAX_ROWS}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const next = v.trim() ? v : null;
          if (next !== (value ?? null)) onCommit(next);
        }}
        placeholder={t("taskPanel.notesPlaceholder")}
        aria-label={t("taskPanel.notes")}
        className="-mx-2 resize-y rounded-card border border-transparent bg-transparent px-2 py-1.5 text-body text-fg leading-5 outline-none placeholder:text-fg3 focus:bg-sunken"
        style={{ outline: "none" }}
      />
      <p className="text-micro text-fg3">{t("taskPanel.notesLocal")}</p>
    </PanelSection>
  );
}

/** 経由: 行と同じ利用者の言葉（GitHub / Claude Code から / Codex から / CLI / 手入力 など）と、URL があれば外部のリンク */
function Via({ task }: { task: TaskView }) {
  const { t } = useI18n();
  const o = task.origin;
  const label = viaLabel(o, t);
  // 拡張が作ったタスク: 拡張の画面へ移る（ExtTaskOrigin.to）
  const origin = o.externalSource ? ext.taskOrigins.get(o.externalSource.toLowerCase()) : undefined;
  return (
    <>
      <span className="text-body text-fg2">{label}</span>
      {origin?.to ? (
        <button
          type="button"
          onClick={() => openInApp(origin.to as string)}
          className="flex items-center text-fg3 hover:text-fg"
          aria-label={t("taskPanel.openOrigin", { name: label })}
          title={t("taskPanel.openOrigin", { name: label })}
          data-testid="task-via-open"
        >
          <ArrowRight size={14} strokeWidth={1.5} />
        </button>
      ) : null}
      {o.externalUrl ? (
        <a
          href={o.externalUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center text-fg3 hover:text-fg"
          aria-label={t("taskPanel.externalLink")}
          title={o.externalUrl}
        >
          <ExternalLink size={14} strokeWidth={1.5} />
        </a>
      ) : null}
    </>
  );
}

/** 紐づかなかった理由と、理由ごとのボタン（B-5。D-193） */
function UnlinkedWhy({ ai }: { ai: TaskAiView }) {
  const { t } = useI18n();
  const why = ai.unlinkedReason;
  const openTerminal = async (trust: boolean) => {
    try {
      const r = await unwrap<{
        outcome: "opened" | "opened_copied" | "copied";
        app: string | null;
      }>(api.api.ai.launches[":id"]["open-for-trust"].$post({ param: { id: ai.launchId } }));
      if (trust)
        toast(
          r.outcome === "opened"
            ? t("launch.trust.opened", { app: r.app ?? "" })
            : t("launch.trust.copied"),
        );
    } catch {
      toast(t("toast.open.failed"));
    }
  };
  const copyResume = async () => {
    try {
      await navigator.clipboard.writeText(`turnlane ai run ${ai.launchId}`);
      toast(t("toast.resumeCopied"));
    } catch {
      toast(t("toast.saveFailed"));
    }
  };
  const text =
    why === "untrusted"
      ? t("launch.unlinked.untrusted")
      : why === "no_session"
        ? t("launch.unlinked.no_session")
        : t("launch.unlinked.exited", {
            code: String(ai.exit?.code ?? "?"),
            sec: String(Math.round((ai.exit?.afterMs ?? 0) / 1000)),
          });
  return (
    <div className="flex flex-col gap-1.5" data-testid="task-ai-unlinked" data-why={why}>
      <p className="text-fg2 text-meta">{text}</p>
      <div className="flex flex-wrap gap-1.5">
        {why === "untrusted" ? (
          <ActionButton onClick={() => void openTerminal(true)}>
            {t("launch.openForTrust")}
          </ActionButton>
        ) : why === "no_session" ? (
          <ActionButton onClick={() => void openTerminal(false)}>
            {t("launch.openTerminal")}
          </ActionButton>
        ) : (
          <ActionButton onClick={() => void copyResume()}>{t("launch.copyResume")}</ActionButton>
        )}
      </div>
    </div>
  );
}

/** 頼んだ AI（D-107。plan §B.2・§B.5）: 状態、リポジトリ · ブランチ、開く先、紐づかなかったときの選択、確認支援 */
function TaskAiSection({
  task,
  ai,
  primary,
}: {
  task: TaskView;
  ai: TaskAiView;
  primary: ReturnType<typeof taskPrimaryOf>;
}) {
  const { t } = useI18n();
  const check = useCheck({ launchId: ai.launchId }).data;
  const [pick, setPick] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [again, setAgain] = useState<HTMLElement | null>(null);
  const showCandidates = async (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const list = await unwrap<LaunchCandidate[]>(
      api.api.ai.launches[":id"].candidates.$get({ param: { id: ai.launchId } }),
    ).catch(() => [] as LaunchCandidate[]);
    setPick({
      x: r.left,
      y: r.bottom + 4,
      entries:
        list.length === 0
          ? [{ id: "none", label: t("launch.noCandidates"), run: () => {} }]
          : list.map((c) => ({
              id: c.sessionId,
              label: `${c.title ?? c.cwd?.split("/").at(-1) ?? c.sessionId.slice(0, 8)}`,
              run: () => void linkLaunch(ai.launchId, c.sessionId),
            })),
    });
  };
  const where = [ai.repoRoot.split("/").at(-1), ai.branch].filter(Boolean).join(" · ");
  // 頭の主のボタンが開く先なら、ここには並べない（主のボタンは1つ）
  const showOpen = ai.workItemId && primary !== "openAi" && primary !== "openTurn";
  const buttons = [
    showOpen ? (
      <ActionButton
        key="open"
        onClick={() => void openTask({ workItemId: ai.workItemId as string })}
      >
        {t("launch.openSession")}
      </ActionButton>
    ) : null,
    ai.workItemId ? (
      <ActionButton
        key="detail"
        onClick={() => setUi({ panelWorkItemId: ai.workItemId as string })}
      >
        {t("launch.openDetail")}
      </ActionButton>
    ) : null,
    ai.state === "unlinked" ? (
      <ActionButton key="pick" onClick={(e) => void showCandidates(e.currentTarget)}>
        {t("launch.pick")}
      </ActionButton>
    ) : null,
    (ai.state === "failed" || ai.state === "unlinked") && task.status !== "done" ? (
      <ActionButton key="again" onClick={(e) => setAgain(e.currentTarget)}>
        {t("launch.again")}
      </ActionButton>
    ) : null,
  ].filter(Boolean);
  return (
    <PanelSection title={t("taskPanel.aiSection")} testId="task-ai-section">
      <TaskAiLine ai={ai} taskId={task.id} />
      {where ? <div className="truncate text-fg2 text-meta">{where}</div> : null}
      {ai.state === "failed" && ai.failReason ? (
        <p className="text-fg2 text-meta" data-testid="task-ai-fail">
          {t(
            ai.failReason === "cli_missing" ? "launch.fail.cli_missing" : "launch.fail.not_claimed",
          )}
          {/* 2 行目（B-5）: ターミナルで CLI が動くことを確かめる */}
          {ai.failReason === "cli_missing" ? (
            <>
              <br />
              {t("launch.fail.cli_missing.hint")}
            </>
          ) : null}
        </p>
      ) : null}
      {/* 紐づかなかった理由（B-5。D-193）: 信頼の確認で止まった / セッションが来ない / すぐ終わった。理由ごとのボタン */}
      {ai.state === "unlinked" && ai.unlinkedReason ? <UnlinkedWhy ai={ai} /> : null}
      {buttons.length > 0 ? <div className="flex flex-wrap gap-1.5">{buttons}</div> : null}
      {check && hasCheckRows(check) ? <CheckRows c={check} /> : null}
      {pick ? (
        <ContextMenu x={pick.x} y={pick.y} entries={pick.entries} onClose={() => setPick(null)} />
      ) : null}
      {again ? <AskAiPopover task={task} anchor={again} onClose={() => setAgain(null)} /> : null}
    </PanelSection>
  );
}
