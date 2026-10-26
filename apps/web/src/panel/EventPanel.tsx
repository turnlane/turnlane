/**
 * 予定の詳細パネル（S6b。D-070。ux-mvp 4.12。D-138 でタスク・AI の詳細パネルと同じ作りにした）:
 * 1. 頭: 大きな題名（編集できる予定はその場で編集）・×
 * 2. 状態の1行（「今日 14:00–15:00 · 1h · ● Work」。時刻と長さは等幅、カレンダーの色の点と名前）
 * 3. ボタンの行: 主のボタン「この予定の間は集中する」（D-130。予定の開始で集中モードになり終わりで戻る。設定済みは押した状態で、
 *    押すと取り消す。終わった予定・終日の予定には出さない）、会議のリンクがあれば「参加する」、「カレンダーで開く」（ボタンが
 *    2つに満たないとき）、右端に「⋯」（右クリックと同じ並び: カレンダーで開く・集中・カレンダーの色 ▸・削除）
 * 4. 属性: 日付・時刻・カレンダー・場所・リンク・予定中に数えるか。編集できる予定（D-093。Turnlane で作った予定と参加者の
 *    いない予定）は値が文字のボタンで、時刻は開始と長さのポップオーバー、カレンダーは色の点の一覧（✓ が今の値）。
 *    読み取りだけの予定は値を文字で出し、理由を1行出す。OS の select と数字の入力欄は使わない
 * 変更は楽観的に出し、失敗したら戻す（mutations.ts の patchEvent / deleteEvent）。変更は ⌘Z で戻し、削除は確認してから行う
 * （⏎ で確定・Esc で取り消し。D-096）。Turnlane が書き戻した予定（M3-3 の時間ブロック）なら、元のタスクのパネルを開く。
 */

import { useQuery } from "@tanstack/react-query";
import { type CalendarEventDetail, fmtClock, fmtDuration, wallClock } from "@turnlane/core/web";
import { CalendarCheck, CalendarDays, Check, Video } from "lucide-react";
import { useEffect, useState } from "react";
import {
  eventFocusState,
  MENU_ICON,
  menuSpec,
  toggleEventFocus,
} from "../actions/item-actions.tsx";
import { PaletteGrid } from "../components/CalendarColors.tsx";
import { ContextMenu, type MenuEntry, type SubPanelCtx } from "../components/ContextMenu.tsx";
import { ConfirmDialog } from "../components/ui.tsx";
import { keys } from "../data/invalidate.ts";
import { deleteEvent, patchEvent, setCalendarColor } from "../data/mutations.ts";
import { useCalendars, useFocus } from "../data/queries.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { todayOrSystem } from "../lib/board-nav.ts";
import { calColor } from "../lib/cal-color.ts";
import { useNow } from "../lib/clock.ts";
import { addDaysSafe } from "../lib/dates.ts";
import { setUi, toast, useUi } from "../lib/store.ts";
import {
  ActionButton,
  Field,
  MoreButton,
  PanelFrame,
  PanelHead,
  ValueButton,
  ValueText,
} from "./PanelFrame.tsx";
import { TimePrompt, TitleInput } from "./TaskPanel.tsx";

const closeEvent = () => setUi({ panelEventId: null });

export function EventPanel() {
  const id = useUi((s) => s.panelEventId);
  const { t } = useI18n();
  const q = useQuery({
    queryKey: keys.calendarEvent(id ?? ""),
    queryFn: () =>
      unwrap<CalendarEventDetail>(
        api.api["calendar-events"][":id"].$get({ param: { id: id ?? "" } }),
      ),
    enabled: id !== null && !id.startsWith("temp-"),
    retry: false,
  });
  // 書き戻した時間ブロックの予定は、元のタスクのパネルにする
  const own = q.data?.ownTimeBlock;
  useEffect(() => {
    if (own?.taskId) setUi({ panelTaskId: own.taskId });
  }, [own?.taskId]);
  if (!id) return null;
  return (
    <PanelFrame label={t("eventPanel.title")} testId="event-panel" variant="detail">
      {!q.data ? (
        <>
          <PanelHead title={t("eventPanel.title")} onClose={closeEvent} />
          <div className="text-body text-fg3">
            {q.isError ? t("eventPanel.notFound") : t("common.loading")}
          </div>
        </>
      ) : (
        <EventBody e={q.data} />
      )}
    </PanelFrame>
  );
}

/** 書き込めて表示しているカレンダー（移す先の選択。今のカレンダーは必ず含める） */
function useWritableCalendars(current: string) {
  return useCalendars((cs) =>
    cs.filter((c) => (c.writable && c.role === "source") || c.id === current),
  );
}

/** その時刻の暦日（'YYYY-MM-DD'） */
function dateOf(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** メニューの置き場所（要素の下。右寄せはメニューの幅 240px） */
function below(el: HTMLElement, alignRight = false): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right - 240 : r.left, y: r.bottom + 4 };
}

async function openInCalendar(id: string, failed: string): Promise<void> {
  try {
    const r = await unwrap<{ outcome: string }>(
      api.api["calendar-events"][":id"].open.$post({ param: { id } }),
    );
    if (r.outcome === "failed") toast(failed);
  } catch {
    toast(failed);
  }
}

type Menu = { x: number; y: number; entries: MenuEntry[] };

function EventBody({ e }: { e: CalendarEventDetail }) {
  const { t, shortDate } = useI18n();
  const tz = e.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cals = useWritableCalendars(e.calendarId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [timePop, setTimePop] = useState<HTMLElement | null>(null);
  const focus = eventFocusState(e, e.id, useFocus().data?.reserved, useNow());
  const date = e.allDay ? (e.startDate ?? dateOf(e.start, tz)) : dateOf(e.start, tz);
  const color = calColor(e.calendarColor, e.calendarColorKey);
  const open = () => void openInCalendar(e.id, t("eventPanel.openFailed"));
  const canMove = e.editable && (cals.data?.length ?? 0) > 1;

  /** 「⋯」: 右クリックと同じ並び（menuSpec。詳細を開くは除く） */
  const moreEntries = (): MenuEntry[] =>
    menuSpec([], { event: { editable: e.editable, calendarId: e.calendarId, focus } })
      .filter((s) => s.id !== "detail")
      .map((s) => ({
        id: s.id,
        label: t(s.label),
        danger: s.danger,
        sep: s.sep,
        icon: MENU_ICON[s.id],
        panel:
          s.action.t === "calColor"
            ? (ctx: SubPanelCtx) => (
                <PaletteGrid
                  value={e.calendarColorKey}
                  sourceColor={e.calendarColor}
                  autoFocus={ctx.autoFocus}
                  onExit={ctx.back}
                  onPick={(key) => {
                    ctx.close();
                    void setCalendarColor(e.calendarId, key);
                  }}
                />
              )
            : undefined,
        run: () => {
          const a = s.action;
          if (a.t === "eventOpen") open();
          else if (a.t === "eventFocus") toggleEventFocus(e.id, a.on);
          else if (a.t === "eventDelete") setConfirmDelete(true);
        },
      }));
  const calendarEntries = (): MenuEntry[] =>
    (cals.data ?? []).map((c) => ({
      id: `cal-${c.id}`,
      label: c.account ? `${c.name} · ${c.account}` : c.name,
      swatch: calColor(c.color, c.colorKey),
      checked: c.id === e.calendarId,
      run: () => {
        if (c.id !== e.calendarId)
          void patchEvent(
            e.id,
            { calendarId: c.id },
            { calendarColor: c.color, calendarColorKey: c.colorKey },
          );
      },
    }));

  // ボタンの行: 主のボタンは集中（出せるとき）、会議のリンク、2つに満たなければ「カレンダーで開く」、右端に ⋯
  const buttons = [
    focus ? (
      <ActionButton
        key="focus"
        primary={focus === "off"}
        pressed={focus === "on"}
        testId="event-focus"
        onClick={() => toggleEventFocus(e.id, focus === "on")}
      >
        {focus === "on" ? (
          <Check size={14} strokeWidth={1.5} aria-hidden="true" />
        ) : (
          <CalendarCheck size={14} strokeWidth={1.5} aria-hidden="true" />
        )}
        {t("focus.event")}
      </ActionButton>
    ) : null,
    e.conferenceUrl ? (
      <ActionButton key="join" href={e.conferenceUrl} testId="event-join">
        <Video size={14} strokeWidth={1.5} aria-hidden="true" />
        {t("eventPanel.join")}
      </ActionButton>
    ) : null,
  ].filter(Boolean);
  if (buttons.length < 2)
    buttons.push(
      <ActionButton key="open" testId="event-open" onClick={open}>
        <CalendarDays size={14} strokeWidth={1.5} aria-hidden="true" />
        {t("eventPanel.openCalendar")}
      </ActionButton>,
    );

  return (
    <>
      <PanelHead
        onClose={closeEvent}
        title={
          e.editable ? (
            <TitleInput
              value={e.title ?? ""}
              onCommit={(v) => void patchEvent(e.id, { title: v })}
              size="head"
            />
          ) : (
            <h2
              className={`min-w-0 flex-1 font-semibold text-[18px] text-fg leading-6 ${e.status === "cancelled" ? "line-through" : ""}`}
            >
              {e.title ?? t("common.none")}
            </h2>
          )
        }
      />
      <div className="-mt-3 flex flex-col gap-2.5">
        <StateLine e={e} tz={tz} date={date} color={color} />
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5" data-testid="event-actions">
          {buttons}
          <MoreButton
            testId="event-more"
            className="ml-auto"
            onClick={(x) => setMenu({ ...below(x.currentTarget, true), entries: moreEntries() })}
          />
        </div>
        {focus ? (
          <p className="-mt-1 text-micro text-fg3" data-testid="event-focus-hint">
            {t(focus === "on" ? "focus.event.on" : "focus.event.hint")}
          </p>
        ) : null}
      </div>

      <section
        className="flex flex-col gap-0.5 border-line border-t pt-4"
        data-testid="event-fields"
      >
        <Field label={t("eventPanel.date")}>
          <ValueText testId="event-date">{shortDate(date)}</ValueText>
        </Field>
        <Field label={t("eventPanel.when")}>
          {e.allDay ? (
            <ValueText testId="event-time">{t("eventPanel.allDay")}</ValueText>
          ) : e.editable ? (
            <ValueButton testId="event-time" mono onClick={(el) => setTimePop(el)}>
              {fmtClock(e.start, tz)}–{fmtClock(e.end, tz)}
            </ValueButton>
          ) : (
            <ValueText testId="event-time" mono>
              {fmtClock(e.start, tz)}–{fmtClock(e.end, tz)}
            </ValueText>
          )}
        </Field>
        <Field label={t("eventPanel.calendar")}>
          {canMove ? (
            <ValueButton
              testId="event-calendar"
              onClick={(el) => setMenu({ ...below(el, true), entries: calendarEntries() })}
            >
              <CalendarName e={e} color={color} />
            </ValueButton>
          ) : (
            <ValueText testId="event-calendar">
              <CalendarName e={e} color={color} />
            </ValueText>
          )}
        </Field>
        {e.location ? (
          <Field label={t("eventPanel.location")}>
            <ValueText title={e.location}>
              <span className="truncate">{e.location}</span>
            </ValueText>
          </Field>
        ) : null}
        {e.conferenceUrl ? (
          <Field label={t("eventPanel.url")}>
            <a
              href={e.conferenceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 min-w-0 items-center truncate text-accent text-body hover:underline"
              title={e.conferenceUrl}
            >
              <span className="truncate">{e.conferenceUrl.replace(/^https?:\/\//, "")}</span>
            </a>
          </Field>
        ) : null}
        <Field label={t("eventPanel.busy")}>
          <span className="inline-flex h-7 items-center text-body text-fg2">
            {e.busy ? t("eventPanel.busy.yes") : t("eventPanel.busy.no")}
          </span>
        </Field>
      </section>

      {/* 読み取りだけの理由（AI の詳細パネルの足と同じ位置・大きさ） */}
      {e.readOnlyReason ? (
        <p className="mt-auto text-[11px] text-fg3 leading-[14px]" data-testid="event-readonly">
          {t(`eventPanel.readOnly.${e.readOnlyReason}` as MessageKey)}
        </p>
      ) : e.createdByTurnlane ? (
        <p className="mt-auto text-[11px] text-fg3 leading-[14px]">{t("eventPanel.madeHere")}</p>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
      ) : null}
      {timePop && !e.allDay ? (
        <TimePrompt
          anchor={timePop}
          date={date}
          block={{ start: e.start, end: e.end }}
          estimateMin={null}
          tz={tz}
          placeLabel={t("action.save")}
          onClose={() => setTimePop(null)}
          onPlace={(start, end) => void patchEvent(e.id, { start, end })}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("eventPanel.deleteTitle", { title: e.title ?? t("common.none") })}
          body={t("eventPanel.deleteBody", { calendar: e.calendarName })}
          confirm={t("eventPanel.deleteConfirm")}
          cancel={t("action.cancel")}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            closeEvent();
            void deleteEvent(e.id);
          }}
        />
      ) : null}
    </>
  );
}

/** 状態の1行: 「今日 14:00–15:00 · 1h · ● Work」（終日は「今日 · 終日」）。時刻と長さは等幅 */
function StateLine({
  e,
  tz,
  date,
  color,
}: {
  e: CalendarEventDetail;
  tz: string;
  date: string;
  color: string;
}) {
  const { t, shortDate } = useI18n();
  const today = todayOrSystem();
  const word =
    date === today
      ? t("taskPanel.date.today")
      : date === addDaysSafe(today, 1)
        ? t("taskPanel.date.tomorrow")
        : shortDate(date);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-body" data-testid="event-state">
      <span className="shrink-0 font-medium text-fg">{word}</span>
      <span className="min-w-0 truncate text-fg2">
        {e.allDay ? (
          ` · ${t("eventPanel.allDay")}`
        ) : (
          <>
            <span className="font-mono">
              {fmtClock(e.start, tz)}–{fmtClock(e.end, tz)}
            </span>
            {" · "}
            <span className="font-mono">{fmtDuration(e.end - e.start)}</span>
          </>
        )}
        {" · "}
        <span
          className="mr-1 inline-block size-2 rounded-full align-middle"
          style={{ background: color }}
          aria-hidden="true"
        />
        {e.calendarName}
      </span>
    </div>
  );
}

/** カレンダーの色の点・名前 · アカウント */
function CalendarName({ e, color }: { e: CalendarEventDetail; color: string }) {
  return (
    <>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: color }}
        aria-hidden="true"
      />
      <span className="truncate">
        {e.calendarName}
        {e.calendarAccount ? <span className="text-fg3"> · {e.calendarAccount}</span> : null}
      </span>
    </>
  );
}
