/**
 * 入力のポップオーバー（M2-4）: `c` の新規タスク（NL パーサのチップ表示）、`r` のタイトル編集、`m` の日付移動、
 * `s` のスヌーズ（30分 / 1時間 / 明日朝 / 時刻を指定…）。どれも Esc で閉じる。
 * 予定（D-093）: `⇧C` と ⌘K の新規予定（時刻を NL パーサで読む）、デイビューの予定のレーンの範囲選択、
 * 3日ボード・週表示の範囲選択の入力欄の「タスク / 予定」の切り替え（Tab、既定はタスク）。予定のときは入力欄を
 * 書き先のカレンダーの色にする（ux-mvp 7章）。書き込めるカレンダーが2つ以上なら、下端で書き先を選べる（初期値は
 * 設定の書き先。選び直してもその予定だけ。event-calendars.ts）
 */
import {
  type AiLaunchTool,
  type CalendarColorKey,
  fmtClock,
  fmtDuration,
  type ParsedTask,
  parseDateInput,
  parseSnoozeTime,
  parseTask,
  type TaskView,
} from "@turnlane/core/web";
import { CalendarDays, CircleCheck, Clock, type LucideIcon, SquareTerminal } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Kbd, MenuItem, Popover } from "../components/ui.tsx";
import type { SnoozeChoice } from "../data/mutations.ts";
import { useCalendars, useEventTarget, useQueue } from "../data/queries.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import {
  AiFields,
  AiFoot,
  AskAiPopover,
  accountInput,
  canLaunch,
  launchWithExt,
  useAiChoice,
  useLaunchOptions,
} from "../launch/AskAi.tsx";
import { Picker, SwitchTrack } from "../launch/Picker.tsx";
import { clockOrDate } from "../lib/back-time.ts";
import { nowMs } from "../lib/clock.ts";
import { isImeKey } from "../lib/ime.ts";
import { atLocal } from "../panel/TaskPanel.tsx";
import {
  choiceColor,
  type EventCalendarChoice,
  eventCalendarChoices,
  eventTargetOf,
  showCalendarPicker,
} from "./event-calendars.ts";

/** ⇥ で確定した候補（誤爆しそうな「3時間目」などはチップにせず、⇥ で確定する。ux-mvp 5章） */
export interface TentativeExtra {
  estimateMin?: number;
  date?: string;
}

export type Prompt =
  | {
      kind: "new";
      date: string | null;
      anchor: HTMLElement | null;
      /** 自分レーンの空白の範囲選択で開いたとき: その時刻に時間ブロックも作る（M2-18） */
      range?: { start: number; end: number };
      /** 作るもの（既定はタスク。D-093） */
      as?: "task" | "event";
      /** 「タスク / 予定」の切り替えを出す（3日ボード・週表示の範囲選択。Tab で切り替え） */
      switchable?: boolean;
    }
  | { kind: "rename"; initial: string; anchor: HTMLElement | null; onSubmit: (v: string) => void }
  | {
      kind: "move";
      anchor: HTMLElement | null;
      onSubmit: (date: string | null) => void;
    }
  | {
      kind: "snooze";
      anchor: HTMLElement | null;
      onSubmit: (choice: SnoozeChoice) => void;
    }
  /** 既存のタスクを AI に頼む（D-107。ホバーのボタン・右クリックの「AI に頼む…」） */
  | { kind: "ai"; task: TaskView; anchor: HTMLElement | null };

/** 作ったタスクを返すと、「AI に頼む」をオンにしていればそのタスクを依頼する（D-107） */
type CreatedTask = Promise<TaskView | null> | undefined;
export type OnCreate = (raw: string, date: string | null, extra: TentativeExtra) => CreatedTask;

export interface NewEvent {
  title: string;
  start: number;
  end: number;
  /** 入力欄で見せた書き先のカレンダーの色（楽観的に出す予定の色） */
  color: string | null;
  /** その Turnlane の中で選んだ色（D-125） */
  colorKey: CalendarColorKey | null;
  calendarId: string | null;
  /** 設定の書き先と違うカレンダーを選んだとき true（そのときだけ API に calendarId を送る） */
  chosen?: boolean;
}

export function PromptView({
  prompt,
  today,
  tz,
  onClose,
  onCreate,
  onCreateEvent,
}: {
  prompt: Prompt;
  today: string;
  /** 予定の時刻を読む tz（D-093） */
  tz?: string;
  onClose: () => void;
  onCreate: OnCreate;
  onCreateEvent?: (e: NewEvent) => void;
}) {
  if (prompt.kind === "snooze") return <SnoozeMenu prompt={prompt} onClose={onClose} />;
  if (prompt.kind === "ai")
    return <AskAiPopover task={prompt.task} anchor={prompt.anchor} onClose={onClose} />;
  return (
    <TextPrompt
      prompt={prompt}
      today={today}
      tz={tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
      onClose={onClose}
      onCreate={onCreate}
      onCreateEvent={onCreateEvent}
    />
  );
}

/** 範囲の無い新規予定の時刻（入力の時刻と長さ。日付は入力 → 列の日付 → 今日）。時刻が無ければ null */
export function eventRangeOf(
  parsed: ParsedTask,
  fallbackDate: string,
  tz: string,
): { start: number; end: number } | null {
  if (!parsed.time) return null;
  const date = parsed.date ?? fallbackDate;
  const start = atLocal(date, parsed.time.hour * 60 + parsed.time.minute, tz);
  return { start, end: start + (parsed.estimateMin ?? 30) * 60_000 };
}

/**
 * `s` のスヌーズ（30分 / 1時間 / 明日朝 / 時刻を指定…）。「時刻を指定…」（4）を選ぶと同じポップオーバーの中が 1 行の入力に
 * 変わる（`9:00` / `明日 9:00` / `10/28 14:00`。core の parseSnoozeTime）。読めない・過ぎた時刻は赤く示して確定しない
 */
function SnoozeMenu({
  prompt,
  onClose,
}: {
  prompt: Extract<Prompt, { kind: "snooze" }>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const opts = [
    { k: "snooze.30m" as const, v: "30m" as const },
    { k: "snooze.1h" as const, v: "1h" as const },
    { k: "snooze.tomorrow" as const, v: "tomorrow_morning" as const },
  ];
  useEffect(() => {
    if (picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (i === 3) {
        setPicking(true);
        return;
      }
      prompt.onSubmit((opts[i] as (typeof opts)[number]).v);
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  if (picking)
    return (
      <Popover anchor={prompt.anchor} onClose={onClose} className="w-72 p-2">
        <SnoozeTimeInput
          onSubmit={(until) => {
            prompt.onSubmit({ until });
            onClose();
          }}
        />
      </Popover>
    );
  return (
    <Popover anchor={prompt.anchor} onClose={onClose} className="w-56">
      {opts.map((o, i) => (
        <MenuItem
          key={o.v}
          hint={String(i + 1)}
          onSelect={() => {
            prompt.onSubmit(o.v);
            onClose();
          }}
        >
          {t(o.k)}
        </MenuItem>
      ))}
      <MenuItem key="pick" hint="4" onSelect={() => setPicking(true)}>
        {t("snooze.pick")}
      </MenuItem>
    </Popover>
  );
}

/** 「時刻を指定…」の 1 行の入力。下に戻る時刻（`9:00 に戻る` / `10/28 14:00 に戻る`）か、赤い理由を出す */
function SnoozeTimeInput({ onSubmit }: { onSubmit: (until: number) => void }) {
  const { t } = useI18n();
  const meta = useQueue().data;
  const tz = meta?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [v, setV] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const read = (x: string) =>
    parseSnoozeTime(x, {
      now: nowMs(),
      tz,
      ...(meta ? { dayBoundary: meta.dayBoundary } : {}),
    });
  const r = v.trim() ? read(v) : null;
  const bad = r !== null && !r.ok;
  return (
    <div data-testid="snooze-pick">
      <input
        ref={input}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            // 値は DOM から読む（変換の確定と同じ打鍵の ⏎ で末尾を落とさない）
            const x = read(input.current?.value ?? v);
            if (x.ok) onSubmit(x.until);
            else setV(input.current?.value ?? v);
          }
        }}
        placeholder={t("snooze.pickPlaceholder")}
        aria-invalid={bad || undefined}
        className={`h-8 w-full rounded-card border bg-raised px-3 text-body outline-none placeholder:text-fg3 focus-visible:outline-none ${bad ? "border-error text-error" : "border-line focus:border-[color-mix(in_srgb,var(--dl-text-3)_55%,var(--dl-border))]"}`}
        style={{ outline: "none" }}
        data-testid="snooze-pick-input"
      />
      {r ? (
        <div
          className={`mt-1.5 px-1 text-meta ${r.ok ? "text-fg3" : "text-error"}`}
          data-testid="snooze-pick-note"
          data-ok={r.ok ? "" : undefined}
        >
          {r.ok
            ? t("snooze.pickBack", { time: clockOrDate(r.until, nowMs(), tz) })
            : t(r.error === "past" ? "snooze.pickPast" : "snooze.pickInvalid")}
        </div>
      ) : null}
    </div>
  );
}

function TextPrompt({
  prompt,
  today,
  tz,
  onClose,
  onCreate,
  onCreateEvent,
}: {
  prompt: Exclude<Prompt, { kind: "snooze" } | { kind: "ai" }>;
  today: string;
  tz: string;
  onClose: () => void;
  onCreate: OnCreate;
  onCreateEvent?: ((e: NewEvent) => void) | undefined;
}) {
  const { t, shortDate } = useI18n();
  const [v, setV] = useState(prompt.kind === "rename" ? prompt.initial : "");
  const [accepted, setAccepted] = useState(false);
  const [as, setAs] = useState<"task" | "event">(
    prompt.kind === "new" ? (prompt.as ?? "task") : "task",
  );
  // 「タスク / 予定」の切り替えは、予定を作れる画面の新規の入力ではいつも出す（確定画像の作成のポップオーバー。R15）
  const switchable = prompt.kind === "new" && !!onCreateEvent;
  const isEvent = prompt.kind === "new" && as === "event";
  // AI に頼む（D-107。タスクのときだけ。スイッチで出す）
  const [aiOn, setAiOn] = useState(false);
  const canAi = prompt.kind === "new" && !isEvent;
  const aiOpts = useLaunchOptions(null, canAi && aiOn);
  const [aiChoice, setAiChoice] = useAiChoice(aiOpts.data);
  const asking = canAi && aiOn;
  const target = useEventTarget();
  const defaultCal = target.data?.calendar ?? null;
  // 書き先の選択（書き込めて無視していないカレンダー。予定を作れる入力のときだけ取る）
  const choices = useCalendars(
    (cs) => eventCalendarChoices(cs, defaultCal),
    prompt.kind === "new" && (!!onCreateEvent || prompt.as === "event"),
  ).data;
  const [picked, setPicked] = useState<string | null>(null);
  const { calendar: cal, explicit } = eventTargetOf(choices ?? [], defaultCal, picked);
  const picker = isEvent && !!choices && showCalendarPicker(choices);
  // 上端・入力欄の色は、Turnlane の中で選んだ色があればそれ（D-125）
  const color = choiceColor(cal);
  const input = useRef<HTMLInputElement>(null);
  const pickerBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const range = prompt.kind === "new" ? prompt.range : undefined;
  const parsed = useMemo(
    () =>
      prompt.kind === "new" && v.trim() && !(isEvent && range) ? parseTask(v, { today }) : null,
    [prompt.kind, v, today, isEvent, range],
  );
  // 範囲の無い予定（⇧C・⌘K）は入力の時刻で作る
  const eventRange =
    isEvent && !range && parsed
      ? eventRangeOf(parsed, (prompt.kind === "new" ? prompt.date : null) ?? today, tz)
      : null;
  const moveTo = prompt.kind === "move" && v.trim() ? parseDateInput(v, { today }) : undefined;
  const placeholder: MessageKey =
    prompt.kind === "new"
      ? isEvent
        ? range
          ? "event.newPlaceholder"
          : "event.newPlaceholderTime"
        : "task.newPlaceholder"
      : prompt.kind === "rename"
        ? "task.renamePlaceholder"
        : "task.movePlaceholder";
  const submit = () => {
    // 値は DOM から読む（変換の確定と同じ打鍵の ⏎ で、状態の反映が遅れても末尾を落とさない）
    const x = (input.current?.value ?? v).trim();
    if (prompt.kind === "new") {
      if (!x) return;
      if (isEvent) {
        const r = range ?? eventRange;
        if (!r || !onCreateEvent) return;
        onCreateEvent({
          title: range ? x : (parsed?.title ?? x),
          start: r.start,
          end: r.end,
          color: cal?.color ?? null,
          colorKey: cal?.colorKey ?? null,
          calendarId: cal?.id ?? null,
          ...(explicit ? { chosen: true } : {}),
        });
      } else if (asking) {
        if (!canLaunch(aiOpts.data, aiChoice) || !aiChoice) return;
        const c = aiChoice;
        // 作ったタスクを依頼する（作成は楽観的に出る。依頼は作成が確定してから）
        void Promise.resolve(onCreate(x, prompt.date, tentativeExtra(parsed, accepted))).then(
          (task) => {
            if (!task) return;
            void launchWithExt(
              {
                taskId: task.id,
                repo: c.repo as string,
                tool: c.tool as AiLaunchTool,
                templateId: c.templateId,
                worktree: c.worktree,
                ...(c.instruction.trim() ? { instruction: c.instruction.trim() } : {}),
                ...accountInput(aiOpts.data, c),
              },
              c.ext,
            );
          },
        );
      } else onCreate(x, prompt.date, tentativeExtra(parsed, accepted));
    } else if (prompt.kind === "rename") {
      if (x && x !== prompt.initial) prompt.onSubmit(x);
    } else if (moveTo !== undefined) prompt.onSubmit(moveTo);
    else return;
    onClose();
  };
  // 予定のときは入力欄をカレンダー色で塗り、ポップオーバーの上端にカレンダー色の線（確定デザインの作成のポップオーバー）
  const evStyle =
    isEvent && color
      ? {
          borderColor: "transparent",
          backgroundColor: `color-mix(in srgb, ${color} var(--dl-ev-tint), var(--dl-raised))`,
        }
      : undefined;
  const newPrompt = prompt.kind === "new";
  return (
    <Popover
      anchor={prompt.anchor}
      onClose={onClose}
      className={`p-4 ${newPrompt ? "w-[440px]" : "w-[380px]"} ${isEvent && color ? "border-t-4" : ""}`}
      style={isEvent && color ? { borderTopColor: color } : undefined}
    >
      {switchable || isEvent ? (
        <div className="mb-3 flex items-center gap-3" data-testid="prompt-kind">
          {switchable ? (
            // タスク / 予定 をクリックで選べる切り替えとして大きく見せる（D-101 (2)、UX 監査 A7・U-16）。Tab は補助
            <div className="flex gap-0.5 rounded-card bg-sunken p-0.5" role="tablist">
              {(["task", "event"] as const).map((k) => {
                const Icon = k === "task" ? CircleCheck : CalendarDays;
                return (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={as === k}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setAs(k)}
                    className={`flex h-7 items-center gap-1.5 rounded-control px-3 font-medium text-body ${as === k ? "bg-raised text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--dl-border)]" : "text-fg2 hover:text-fg"}`}
                    data-kind-option={k}
                  >
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                    {t(k === "task" ? "prompt.kind.task" : "prompt.kind.event")}
                  </button>
                );
              })}
            </div>
          ) : (
            <span className="flex items-center gap-1.5 font-medium text-body text-fg">
              <CalendarDays size={16} strokeWidth={1.5} aria-hidden="true" />
              {t("prompt.kind.event")}
            </span>
          )}
          {switchable ? (
            <span className="ml-auto shrink-0 text-fg3 text-meta">{t("prompt.kindHint")}</span>
          ) : null}
        </div>
      ) : null}
      <input
        ref={input}
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          setAccepted(false);
        }}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (
            e.key === "Tab" &&
            parsed &&
            parsed.tentative.length > 0 &&
            !accepted &&
            !isEvent
          ) {
            // 誤爆しそうな候補（「3時間目」など）があるときの ⇥ は候補の確定（ux-mvp 5章）
            e.preventDefault();
            setAccepted(true);
          } else if (e.key === "Tab" && e.shiftKey && picker) {
            // ⇧⇥ は書き先の選択へ（⇥ は「タスク / 予定」の切り替えに使うため）
            e.preventDefault();
            pickerBox.current?.querySelector("button")?.focus();
          } else if (e.key === "Tab" && switchable) {
            // それ以外の ⇥ は「タスク / 予定」の切り替え（D-093）
            e.preventDefault();
            setAs((k) => (k === "task" ? "event" : "task"));
          }
        }}
        placeholder={t(placeholder)}
        className={`w-full rounded-card border border-line px-3 text-body outline-none placeholder:text-fg3 focus:border-[color-mix(in_srgb,var(--dl-text-3)_55%,var(--dl-border))] focus-visible:outline-none ${newPrompt ? "h-8 bg-bg" : "h-8 bg-raised"}`}
        // フォーカスは枠の色だけ（確定画像。全体の :focus-visible の太い輪を出さない）
        style={{ outline: "none", ...evStyle }}
        data-event={isEvent ? "" : undefined}
        data-testid="prompt-input"
      />
      {range && newPrompt ? (
        // 空き枠から開いたときの日付と時刻（確定デザインの作成のポップオーバー）
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="prompt-range">
          <PopChip icon={CalendarDays}>{shortDate(prompt.date ?? today)}</PopChip>
          <PopChip icon={Clock} mono>
            {fmtClock(range.start, tz)}–{fmtClock(range.end, tz)}
          </PopChip>
        </div>
      ) : null}
      {parsed && !isEvent ? (
        <ParsedChips
          parsed={parsed}
          fallbackDate={prompt.kind === "new" ? prompt.date : null}
          accepted={accepted}
          className="mt-2"
          pop={prompt.kind === "new"}
        />
      ) : null}
      {isEvent && !range && v.trim() ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-meta">
          {eventRange && parsed ? (
            <>
              <Chip>
                {t("task.chip.date")}{" "}
                {shortDate(parsed.date ?? (prompt.kind === "new" ? prompt.date : null) ?? today)}
              </Chip>
              <Chip>
                {t("task.chip.time")} {String(parsed.time?.hour ?? 0).padStart(2, "0")}:
                {String(parsed.time?.minute ?? 0).padStart(2, "0")}
              </Chip>
              <Chip>{fmtDuration(eventRange.end - eventRange.start)}</Chip>
            </>
          ) : (
            <span className="text-fg3">{t("event.needTime")}</span>
          )}
        </div>
      ) : null}
      {canAi ? (
        <div className="mt-3 border-line border-t pt-3">
          <button
            type="button"
            role="switch"
            aria-checked={aiOn}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAiOn((v) => !v)}
            className="flex h-7 w-full items-center gap-2 text-body text-fg"
            data-testid="ai-switch"
          >
            <SquareTerminal size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
            <span className="flex-1 text-left font-medium">{t("launch.switch")}</span>
            <SwitchTrack on={aiOn} />
          </button>
          {aiOn ? (
            <div className="mt-2">
              <AiFields
                opts={aiOpts.data}
                choice={aiChoice}
                onChange={(c) => setAiChoice(c)}
                onSubmit={submit}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {prompt.kind === "new" ? (
        // マウスだけでも作れるように「作成」のボタン（⏎ と同じ。UX 監査 6.1 の「マウスで完結する」）。予定は作成先のカレンダー
        <div className="mt-4 flex items-center justify-end gap-2">
          {asking ? <AiFoot opts={aiOpts.data} /> : null}
          {picker ? (
            <div ref={pickerBox} className="mr-auto min-w-0" data-testid="event-calendar-row">
              <CalendarPicker
                choices={choices ?? []}
                value={cal?.id ?? null}
                label={t("event.calendar")}
                onChange={(id) => {
                  setPicked(id);
                  // キーで選んだ後も ⏎ で作れるように入力欄へ戻す
                  input.current?.focus();
                }}
              />
            </div>
          ) : isEvent && cal ? (
            <span className="mr-auto flex min-w-0 items-center gap-1.5 text-body text-fg2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: color ?? "var(--dl-text-3)" }}
                aria-hidden="true"
              />
              <span className="truncate">{t("event.in", { name: cal.name })}</span>
            </span>
          ) : null}
          <Button variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
            {t("action.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!v.trim() || (asking && !canLaunch(aiOpts.data, aiChoice))}
            onMouseDown={(e) => e.preventDefault()}
            onClick={submit}
            data-testid="prompt-create"
          >
            {asking ? t("launch.createAndAsk") : t("prompt.create")}
            <span className="font-mono text-micro opacity-70">{asking ? "⌘↵" : "↵"}</span>
          </Button>
        </div>
      ) : null}
      {prompt.kind === "move" && v.trim() ? (
        <div className="mt-2 text-meta text-fg2">
          {moveTo === undefined ? "?" : moveTo === null ? t("task.inbox") : shortDate(moveTo)}
        </div>
      ) : null}
    </Popover>
  );
}

/** 書き先の選択（色の点と名前。アカウントごとの見出し。一覧は上に開く） */
export function CalendarPicker({
  choices,
  value,
  label,
  onChange,
}: {
  choices: readonly EventCalendarChoice[];
  value: string | null;
  label: string;
  onChange: (id: string) => void;
}) {
  return (
    <Picker
      label={label}
      value={value}
      testId="event-calendar-picker"
      up
      className="w-[200px]"
      options={choices.map((c) => ({
        value: c.id,
        label: c.name,
        dot: choiceColor(c),
        group: c.account,
        title: c.account ? `${c.name} · ${c.account}` : c.name,
      }))}
      onChange={onChange}
    />
  );
}

/** 作成のポップオーバーのチップ（日付・時刻。枠付き、アイコン付き） */
function PopChip({
  icon: Icon,
  mono = false,
  children,
}: {
  icon: LucideIcon;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-control border border-line px-2 text-body text-fg ${mono ? "font-mono" : ""}`}
    >
      <Icon size={14} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
      {children}
    </span>
  );
}

/** NL パーサの結果のチップ（日付・時刻・見積・プロジェクト・優先度・いつか、誤爆しそうな候補は ⇥ で確定） */
export function ParsedChips({
  parsed,
  fallbackDate,
  accepted,
  className = "",
  pop = false,
}: {
  parsed: ParsedTask;
  /** パーサが日付を読まなかったときに入る日付（null なら Inbox） */
  fallbackDate: string | null;
  accepted: boolean;
  className?: string;
  /** 作成のポップオーバーの枠付きのチップ（確定画像の「金 10/2」「見積 30m」。等幅は数字の長さ・時刻だけ。D-101） */
  pop?: boolean;
}) {
  const { t, shortDate } = useI18n();
  if (pop)
    return (
      <PopChips
        parsed={parsed}
        fallbackDate={fallbackDate}
        accepted={accepted}
        className={className}
      />
    );
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {parsed.date ? (
        <Chip>
          {t("task.chip.date")} {shortDate(parsed.date)}
        </Chip>
      ) : fallbackDate && !parsed.inbox ? (
        <Chip>
          {t("task.chip.date")} {shortDate(fallbackDate)}
        </Chip>
      ) : (
        <Chip>{t("task.inbox")}</Chip>
      )}
      {parsed.time ? (
        <Chip>
          {t("task.chip.time")} {String(parsed.time.hour).padStart(2, "0")}:
          {String(parsed.time.minute).padStart(2, "0")}
        </Chip>
      ) : null}
      {parsed.estimateMin !== null ? (
        <Chip>
          {t("task.chip.estimate")} {fmtDuration(parsed.estimateMin * 60_000)}
        </Chip>
      ) : null}
      {parsed.project ? <Chip>#{parsed.project}</Chip> : null}
      {parsed.priority !== null ? <Chip>!{parsed.priority}</Chip> : null}
      {parsed.someday ? <Chip>{t("task.chip.someday")}</Chip> : null}
      {parsed.tentative.length > 0 ? (
        accepted ? (
          parsed.tentative.map((x) => <Chip key={x.start}>{x.text}</Chip>)
        ) : (
          <span className="flex items-center gap-1 text-meta text-fg3">
            {parsed.tentative.map((x) => x.text).join(", ")}? <Kbd>⇥</Kbd> {t("task.chip.confirm")}
          </span>
        )
      ) : null}
    </div>
  );
}

function PopChips({
  parsed,
  fallbackDate,
  accepted,
  className,
}: {
  parsed: ParsedTask;
  fallbackDate: string | null;
  accepted: boolean;
  className: string;
}) {
  const { t, dayLabel } = useI18n();
  const chip = (key: string, body: ReactNode) => (
    <span
      key={key}
      className="inline-flex h-6 items-center gap-1 rounded-control border border-line px-1.5 text-fg2 text-meta tabular-nums"
    >
      {body}
    </span>
  );
  const date = parsed.date ?? (fallbackDate && !parsed.inbox ? fallbackDate : null);
  const d = date ? dayLabel(date) : null;
  const hm = parsed.time
    ? `${String(parsed.time.hour).padStart(2, "0")}:${String(parsed.time.minute).padStart(2, "0")}`
    : null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} data-testid="prompt-chips">
      {d ? chip("date", `${d.weekday} ${d.date}`) : chip("inbox", t("task.inbox"))}
      {hm ? chip("time", <span className="font-mono">{hm}</span>) : null}
      {parsed.estimateMin !== null
        ? chip(
            "est",
            <>
              {t("task.chip.estimate")}
              <span className="font-mono">{fmtDuration(parsed.estimateMin * 60_000)}</span>
            </>,
          )
        : null}
      {parsed.project ? chip("project", `#${parsed.project}`) : null}
      {parsed.priority !== null ? chip("priority", `!${parsed.priority}`) : null}
      {parsed.someday ? chip("someday", t("task.chip.someday")) : null}
      {parsed.tentative.length > 0 ? (
        accepted ? (
          parsed.tentative.map((x) => chip(`t${x.start}`, x.text))
        ) : (
          <span className="flex items-center gap-1 text-fg3 text-meta">
            {parsed.tentative.map((x) => x.text).join(", ")}? <Kbd>⇥</Kbd> {t("task.chip.confirm")}
          </span>
        )
      ) : null}
    </div>
  );
}

/** ⇥ で確定した候補を、作成の追加情報にする */
export function tentativeExtra(parsed: ParsedTask | null, accepted: boolean): TentativeExtra {
  const extra: TentativeExtra = {};
  if (accepted)
    for (const c of parsed?.tentative ?? []) {
      if (c.value.estimateMin != null) extra.estimateMin = c.value.estimateMin;
      if (c.value.date != null) extra.date = c.value.date;
    }
  return extra;
}
