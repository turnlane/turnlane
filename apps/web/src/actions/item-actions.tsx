/**
 * 項目のマウスの操作（UX 監査 2026-10 の (a)。5.P3「見える操作の3層」と 5.P4「クリックの規則」。D-099・D-101）。
 *
 * - 1クリック: 選択して詳細パネルを開く（タスク → タスクのパネル、自分の番・AI → AI 詳細パネル、予定 → 予定のパネル）。
 *   ⌘ クリックで選択に加える・外す、⇧ クリックで範囲選択（同じ列・一覧の中）
 * - ダブルクリック: タスクは名前の変更、自分の番・AI は外部の開き先（⏎ と同じ）
 * - ホバーのボタン・右クリックメニュー: その項目を選んでから（複数選択の中なら選択のまま）キーの処理（keymap の id）を呼ぶ。
 *   キーで動くものと同じ処理を通るので、キーの割り当て（D-077）と挙動が一致する。メニューの右には今の割り当てを添える
 * - パネルは選択に追従する（パネルを開いている間に j / k で選び直すと、パネルの中身も変わる）
 *
 * 画面（ボード・デイビュー・キュー・メニューバー）が useItemActionsHost で選択の仕方を渡し、ItemActions の文脈で配る。
 * 行・カード（TurnRow・TaskCard・AiRunBlock・EventBlock）は文脈があればそれを使う（儀式の画面には文脈が無く、今のまま）
 */

import type { CalendarEventView, TaskView } from "@turnlane/core/web";
import { isGrace, isLater, laterFollowUp } from "@turnlane/core/web";
import {
  ArrowRightToLine,
  Ban,
  CalendarArrowUp,
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  Check,
  CircleCheck,
  Clock,
  EyeOff,
  Info,
  type LucideIcon,
  MessageSquareReply,
  Palette,
  Pencil,
  Reply,
  RotateCcw,
  SquareArrowOutUpRight,
  SquareTerminal,
  Sun,
  Timer,
  Trash2,
  Undo2,
} from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { PaletteGrid } from "../components/CalendarColors.tsx";
import { ContextMenu, type MenuEntry, type SubPanelCtx } from "../components/ContextMenu.tsx";
import { ConfirmDialog } from "../components/ui.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { setCalendarHidden } from "../data/calendar-visibility.ts";
import {
  cancelFocusReservation,
  deleteEvent,
  openTask,
  patchWorkItem,
  reserveFocus,
  setCalendarColor,
} from "../data/mutations.ts";
import { useFocus } from "../data/queries.ts";
import { ext } from "../ext/registry.ts";
import type { ExtTaskMenuItem } from "../ext/types.ts";
import { type AnyMessageKey, type MessageKey, useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { dispatchKey } from "../keys/use-keys.ts";
import { AskAiPopover } from "../launch/AskAi.tsx";
import { api, unwrap } from "../lib/api.ts";
import { nowMs } from "../lib/clock.ts";
import { usePanelsAvailable } from "../lib/panels.ts";
import { lastPointerMods } from "../lib/pointer-mods.ts";
import { anyPanelOpen, getUi, type SelItem, setUi, toast } from "../lib/store.ts";

export type SelectHow = "replace" | "toggle" | "range";

/** 項目のキー（`task:<id>` / `turn:<workItemId>` / `ai:<workItemId>` / `event:<id>`） */
export type ItemKind = "task" | "turn" | "ai" | "event";

export function kindOf(key: string): ItemKind | null {
  const k = key.split(":")[0];
  return k === "task" || k === "turn" || k === "ai" || k === "event" ? k : null;
}

export interface ItemActionsApi {
  /** 1クリック（⇧ / ⌘ を見て範囲選択・追加。修飾なしなら詳細パネルも開く） */
  click: (key: string) => void;
  /** ダブルクリック */
  doubleClick: (key: string) => void;
  /** ホバーのボタン: その項目を選んでからキーの処理を呼ぶ（askAi はキーではなくポップオーバーを開く） */
  run: (key: string, id: string, anchor?: HTMLElement) => void;
  /** 右クリック（と `…` のボタン） */
  menu: (e: { clientX: number; clientY: number; preventDefault: () => void }, key: string) => void;
  /** 任意の行のメニュー（空き枠の右クリック） */
  openMenu: (x: number, y: number, entries: MenuEntry[]) => void;
}

const Ctx = createContext<ItemActionsApi | null>(null);
export const ItemActionsProvider = Ctx.Provider;

export function useItemActions(): ItemActionsApi | null {
  return useContext(Ctx);
}

// ---------- メニューの中身（純粋関数。テストする） ----------

export type MenuAction =
  /** 画面のキーの処理（keymap の id。キーの無い画面の処理（後での「今やる」の wake）も同じ経路で呼ぶ） */
  | { t: "key"; id: string }
  /** 詳細パネル */
  | { t: "panel" }
  | { t: "aiPatch"; json: { manualDone?: boolean; hidden?: boolean } }
  | { t: "eventOpen" }
  | { t: "eventDelete" }
  /** カレンダーの色 ▸（D-125。サブメニューのパレット） */
  | { t: "calColor" }
  /** このカレンダーを表示しない（Issue #5。戻すのは上部バーの「カレンダー」） */
  | { t: "hideCalendar" }
  /** この予定の間は集中する（D-130。on なら取り消す） */
  | { t: "eventFocus"; on: boolean }
  /** 既存のタスクを AI に頼む（D-107） */
  | { t: "askAi" }
  /** 拡張の項目（ADR 0015。key は `<拡張の id>:<項目の id>`） */
  | { t: "ext"; key: string };

export interface MenuSpec {
  id: string;
  label: AnyMessageKey;
  /** 右に添えるキー（keymap の id。今の割り当てを出す） */
  keyId?: string;
  danger?: boolean;
  sep?: boolean;
  action: MenuAction;
}

const key = (id: string, label: MessageKey, extra: Partial<MenuSpec> = {}): MenuSpec => ({
  id,
  label,
  keyId: id,
  action: { t: "key", id },
  ...extra,
});

/**
 * 項目（1件、または複数選択）の右クリックメニュー（5.P3 の表）。キーは keymap と同じ id
 * - placed: タスクが時間軸に置かれている（「時間から外す」を出す）
 * - event: 予定のとき、編集できるか（削除を出す）と、カレンダー（あれば「カレンダーの色 ▸」。D-125）、
 *   「この予定の間は集中する」（focus。終わった予定・終日の予定は null で出さない。on は設定済み。D-130）
 */
export function menuSpec(
  items: readonly SelItem[],
  opts: {
    placed?: boolean;
    event?: { editable: boolean; calendarId?: string; focus?: "on" | "off" | null } | null;
    /** 自分の番の「答える」を出す（D-238） */
    answer?: boolean;
  } = {},
  extMenu: readonly (ExtTaskMenuItem & { key: string })[] = ext.taskMenuItems,
): MenuSpec[] {
  if (opts.event) {
    const out: MenuSpec[] = [
      { id: "detail", label: "menu.detail", keyId: "detail", action: { t: "panel" } },
      { id: "eventOpen", label: "menu.eventOpen", action: { t: "eventOpen" } },
    ];
    // この予定の間は集中する（D-130）。設定済みは ✓ を添え、選ぶと取り消す
    if (opts.event.focus)
      out.push({
        id: "eventFocus",
        label: opts.event.focus === "on" ? "menu.eventFocusOn" : "menu.eventFocus",
        sep: true,
        action: { t: "eventFocus", on: opts.event.focus === "on" },
      });
    // カレンダーの色（D-125。Turnlane の中だけ。読み取りのみのカレンダーの予定でも選べる）
    if (opts.event.calendarId)
      out.push(
        { id: "calColor", label: "menu.calColor", sep: true, action: { t: "calColor" } },
        { id: "hideCalendar", label: "menu.hideCalendar", action: { t: "hideCalendar" } },
      );
    if (opts.event.editable)
      out.push({
        id: "eventDelete",
        label: "menu.eventDelete",
        danger: true,
        sep: true,
        action: { t: "eventDelete" },
      });
    return out;
  }
  if (items.length === 0) return [];
  const one = items.length === 1;
  const kinds = new Set(items.map((x) => x.kind));
  if (kinds.size > 1) {
    // 種類が混ざった複数選択: どれにも効く操作だけ（完了はタスクと自分の番、削除はタスクだけに効く）
    const out: MenuSpec[] = [key("complete", "menu.complete")];
    if (kinds.has("task"))
      out.push(
        key("today", "menu.today"),
        key("delete", "menu.delete", { danger: true, sep: true }),
      );
    return out;
  }
  const kind = items[0]?.kind;
  // 並びは確定デザインの部品シート（開く・完了 / 日付と時間 / 削除）
  if (kind === "task") {
    const done = items.every((x) => x.kind === "task" && x.task.status === "done");
    const out: MenuSpec[] = [];
    if (one) out.push(key("detail", "menu.detail"));
    out.push(key("complete", done ? "menu.uncomplete" : "menu.complete"));
    // AI に頼む…（確定デザイン board-CreateTask の右クリック。1件・未完了のときだけ）
    if (one && !done) out.push({ id: "askAi", label: "menu.askAi", action: { t: "askAi" } });
    // 拡張の項目（ADR 0015。1件・未完了のときだけ。公開のビルドでは無い）
    const only = items[0];
    if (one && !done && only?.kind === "task")
      for (const x of extMenu)
        if (!x.when || x.when(only.task))
          out.push({ id: `ext:${x.key}`, label: x.label, action: { t: "ext", key: x.key } });
    out.push(
      key("today", "menu.today", { sep: true }),
      key("later", "menu.later"),
      key("move", "menu.move"),
    );
    if (one) out.push(key("place", "menu.place"), key("rename", "menu.rename"));
    if (opts.placed) out.push(key("unblock", "menu.unblock"));
    out.push(key("delete", "menu.delete", { danger: true, sep: true }));
    return out;
  }
  if (kind === "turn") {
    // 後での行（スヌーズ中・明日へ・リセット前の上限待ち。自分の番の画面）: 今やる（上限待ちには無い）・開く・詳細・対応不要。
    // 明日へ・スヌーズ・完了は出さない
    if (items.every((x) => x.kind === "turn" && isLater(x.item))) {
      if (!one) return [];
      const only = items[0];
      const out: MenuSpec[] = [];
      if (only?.kind === "turn" && laterFollowUp(only.item))
        out.push({ id: "wake", label: "queue.later.wake", action: { t: "key", id: "wake" } });
      out.push(
        key("open", "menu.openTurn"),
        key("detail", "menu.detail"),
        key("dismiss", "menu.dismiss", { danger: true, sep: true }),
      );
      return out;
    }
    // 猶予中の問い（D-245）: 返答タスクが無いので 開く・答える・詳細 だけ（完了・明日へ・スヌーズ・対応不要は出さない）
    if (items.every((x) => x.kind === "turn" && isGrace(x.item))) {
      const out: MenuSpec[] = [key("open", "menu.openTurn")];
      if (one && opts.answer) out.push(key("answer", "menu.answer"));
      if (one) out.push(key("detail", "menu.detail"));
      return out;
    }
    // 開く・他の開き方・詳細・完了 / 明日へ・スヌーズ / 対応不要（確定デザインの自分の番の右クリック）
    const out: MenuSpec[] = [key("open", "menu.openTurn")];
    // 答える（D-238）: 1 件で、問い・許可・エラーの待ち（opts.answer）
    if (one && opts.answer) out.push(key("answer", "menu.answer"));
    if (one) out.push(key("openWith", "menu.openWith"), key("detail", "menu.detail"));
    out.push(
      key("complete", "menu.complete"),
      key("move", "menu.tomorrow", { sep: true }),
      key("snooze", "menu.snooze"),
      key("dismiss", "menu.dismiss", { danger: true, sep: true }),
    );
    return out;
  }
  // AI の作業
  if (!one) return [];
  return [
    key("open", "menu.openAi"),
    key("detail", "menu.detail"),
    key("openWith", "menu.openWith"),
    key("replyTask", "menu.reply", { sep: true }),
    key("backToTurn", "menu.backToTurn"),
    { id: "aiDone", label: "menu.aiDone", action: { t: "aiPatch", json: { manualDone: true } } },
    {
      id: "aiHide",
      label: "menu.aiHide",
      danger: true,
      sep: true,
      action: { t: "aiPatch", json: { hidden: true } },
    },
  ];
}

/** メニューの行のアイコン（確定デザインの部品シート。lucide のアウトライン） */
export const MENU_ICON: Record<string, LucideIcon> = {
  detail: Info,
  complete: Check,
  today: Sun,
  later: CalendarArrowUp,
  move: ArrowRightToLine,
  place: Clock,
  rename: Pencil,
  unblock: Undo2,
  delete: Trash2,
  open: SquareArrowOutUpRight,
  openWith: SquareTerminal,
  snooze: Timer,
  dismiss: Ban,
  replyTask: MessageSquareReply,
  backToTurn: RotateCcw,
  answer: Reply,
  aiDone: CircleCheck,
  aiHide: EyeOff,
  eventOpen: CalendarDays,
  eventDelete: Trash2,
  calColor: Palette,
  hideCalendar: EyeOff,
  eventFocus: CalendarCheck,
  newTask: CircleCheck,
  newEvent: CalendarPlus,
  focus: CalendarCheck,
  askAi: SquareTerminal,
};

/** 項目の詳細パネルを開く（パネルは1つだけ。D-070） */
export function openPanelFor(k: string): void {
  const kind = kindOf(k);
  const id = k.slice(k.indexOf(":") + 1);
  if (kind === "task") setUi({ panelTaskId: id });
  else if (kind === "turn" || kind === "ai") setUi({ panelWorkItemId: id });
  else if (kind === "event") setUi({ panelEventId: id });
}

/** パネルを開いている間は、選び直した項目のパネルに切り替える（UX 監査 A3・U-07） */
export function usePanelFollow(selKey: string | null): void {
  useEffect(() => {
    if (!selKey || !anyPanelOpen(getUi())) return;
    openPanelFor(selKey);
  }, [selKey]);
}

/** 右クリックメニューに要る予定の値 */
export type EventFacts = Pick<
  CalendarEventView,
  "editable" | "title" | "calendarId" | "calendarColor" | "calendarColorKey"
> &
  Partial<Pick<CalendarEventView, "start" | "end" | "allDay">>;

/**
 * 予定の「この予定の間は集中する」の状態（D-130）: 設定済みなら on、設定できるなら off、終わった予定・終日の予定・時刻の
 * 分からない予定は null
 */
export function eventFocusState(
  e: Partial<Pick<CalendarEventView, "id" | "start" | "end" | "allDay">> | null | undefined,
  id: string,
  reserved: readonly { eventId: string }[] | undefined,
  now: number,
): "on" | "off" | null {
  if (reserved?.some((r) => r.eventId === id)) return "on";
  if (!e || e.allDay || e.end === undefined || e.end <= now) return null;
  return "off";
}

/** 予定の集中を切り替える（D-130） */
export function toggleEventFocus(id: string, on: boolean): void {
  void (on ? cancelFocusReservation(id) : reserveFocus(id));
}

export interface HostOptions {
  /** 項目を選ぶ（replace: その項目だけ / toggle: 選択に加える・外す / range: 今の選択からその項目まで） */
  select: (key: string, how: SelectHow) => void;
  /** その項目が複数選択の中にあるか（あればメニューは選択の全件に効く） */
  inMulti: (key: string) => boolean;
  /** メニューの対象（複数選択の中ならその全件、そうでなければその項目） */
  itemsFor: (key: string) => SelItem[];
  /** タスクが時間軸に置かれているか */
  placed?: (key: string) => boolean;
  /** 予定（編集できるか・題名・カレンダーとその色。D-125） */
  eventOf?: (id: string) => EventFacts | null;
  /** 詳細パネルの代わり（メニューバーは main ウインドウを出してパネルを開く） */
  openDetail?: (key: string) => void;
}

/** 画面のマウスの操作をまとめる（文脈の値と、メニュー・確認の描画） */
export function useItemActionsHost(o: HostOptions): { api: ItemActionsApi; node: ReactNode } {
  const { t } = useI18n();
  const panels = usePanelsAvailable();
  const focus = useFocus();
  const answerOn = useAnswerEnabled();
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; title: string; calendar: string } | null>(
    null,
  );
  // AI に頼む（D-107）: ホバーのボタンと右クリックから。項目の要素の下に出す
  const [ask, setAsk] = useState<{ task: TaskView; anchor: HTMLElement | null } | null>(null);
  const askAi = (k: string, anchor?: HTMLElement | null) => {
    const it = o.itemsFor(k).find((x) => x.kind === "task");
    if (it?.kind !== "task") return;
    const id = k.slice(k.indexOf(":") + 1);
    setAsk({
      task: it.task,
      anchor:
        anchor ??
        document.querySelector<HTMLElement>(`[data-kind="task"][data-id="${CSS.escape(id)}"]`),
    });
  };
  const detail = (k: string) => {
    if (o.openDetail) o.openDetail(k);
    else if (panels) openPanelFor(k);
  };
  const selectNow = (k: string) => {
    // 次のキーの処理が新しい選択を読めるように、選択を同期で描き直す
    if (!o.inMulti(k)) flushSync(() => o.select(k, "replace"));
  };
  const run = (k: string, id: string, anchor?: HTMLElement) => {
    selectNow(k);
    if (id === "askAi") askAi(k, anchor);
    else dispatchKey(id);
  };
  const runSpec = (k: string, s: MenuSpec) => {
    const id = k.slice(k.indexOf(":") + 1);
    const a = s.action;
    if (a.t === "key") {
      if (a.id === "detail") detail(k);
      else if (a.id === "open" && kindOf(k) === "ai")
        // AI の開く: クリップボードへのコピーをクリックの中で始める（WebKit。openTask の注）
        void openTask({ workItemId: id });
      else run(k, a.id);
    } else if (a.t === "panel") detail(k);
    else if (a.t === "aiPatch") void patchWorkItem(id, a.json);
    else if (a.t === "askAi") askAi(k);
    else if (a.t === "ext") {
      const it = o.itemsFor(k).find((x) => x.kind === "task");
      const item = ext.taskMenuItems.find((x) => x.key === a.key);
      if (it?.kind === "task" && item)
        item.run(
          it.task,
          document.querySelector<HTMLElement>(`[data-kind="task"][data-id="${CSS.escape(id)}"]`),
        );
    } else if (a.t === "eventOpen") void openEvent(id, () => toast(t("eventPanel.openFailed")));
    else if (a.t === "eventFocus") toggleEventFocus(id, a.on);
    else if (a.t === "hideCalendar") {
      const cal = o.eventOf?.(id)?.calendarId;
      if (cal) void setCalendarHidden(cal, true);
    } else if (a.t === "eventDelete") {
      // 確認の文にカレンダーの名前を出す（予定のパネルの削除と同じ文）
      const e = o.eventOf?.(id);
      void unwrap<{ calendarName: string }>(
        api.api["calendar-events"][":id"].$get({ param: { id } }),
      )
        .then((d) => d.calendarName)
        .catch(() => "")
        .then((calendar) => setConfirm({ id, title: e?.title ?? t("common.none"), calendar }));
    }
  };
  const showMenu = (x: number, y: number, k: string) => {
    const kind = kindOf(k);
    const found = kind === "event" ? (o.eventOf?.(k.slice(6)) ?? null) : null;
    const ev =
      kind === "event"
        ? {
            ...(found ?? { editable: false }),
            focus: eventFocusState(found, k.slice(6), focus.data?.reserved, nowMs()),
          }
        : null;
    const its = kind === "event" ? [] : o.itemsFor(k);
    const only = its.length === 1 ? its[0] : undefined;
    const specs = menuSpec(its, {
      placed: o.placed?.(k) ?? false,
      event: ev,
      answer: answerOn && only?.kind === "turn" && answerable(only.item),
    });
    // カレンダーの色 ▸ のサブメニュー（パレット。選ぶとそのカレンダーの予定すべての色が変わる）
    const palette = found?.calendarId
      ? (ctx: SubPanelCtx) => (
          <PaletteGrid
            value={found.calendarColorKey}
            sourceColor={found.calendarColor}
            autoFocus={ctx.autoFocus}
            onExit={ctx.back}
            onPick={(key) => {
              ctx.close();
              void setCalendarColor(found.calendarId, key);
            }}
          />
        )
      : undefined;
    if (specs.length === 0) return;
    setMenu({
      x,
      y,
      entries: specs.map((s) => ({
        id: s.id,
        label: t(s.label),
        keys: s.keyId ? keyHint(s.keyId) : undefined,
        danger: s.danger,
        sep: s.sep,
        icon: MENU_ICON[s.id],
        sub: s.id === "openWith",
        panel: s.action.t === "calColor" ? palette : undefined,
        run: () => runSpec(k, s),
      })),
    });
  };
  const close = useCallback(() => setMenu(null), []);
  const actions: ItemActionsApi = {
    click: (k) => {
      const m = lastPointerMods();
      if (m.meta) o.select(k, "toggle");
      else if (m.shift) o.select(k, "range");
      else {
        o.select(k, "replace");
        detail(k);
      }
    },
    doubleClick: (k) => {
      const kind = kindOf(k);
      if (kind === "task") run(k, "rename");
      else if (kind === "turn") run(k, "open");
      else if (kind === "ai") void openTask({ workItemId: k.slice(3) });
    },
    run,
    menu: (e, k) => {
      e.preventDefault();
      if (kindOf(k) !== "event") selectNow(k);
      showMenu(e.clientX, e.clientY, k);
    },
    openMenu: (x, y, entries) => setMenu({ x, y, entries }),
  };
  const node = (
    <>
      {menu ? <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={close} /> : null}
      {ask ? (
        <AskAiPopover task={ask.task} anchor={ask.anchor} onClose={() => setAsk(null)} />
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title={t("eventPanel.deleteTitle", { title: confirm.title })}
          body={t("eventPanel.deleteBody", { calendar: confirm.calendar })}
          confirm={t("eventPanel.deleteConfirm")}
          cancel={t("action.cancel")}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const id = confirm.id;
            setConfirm(null);
            if (getUi().panelEventId === id) setUi({ panelEventId: null });
            void deleteEvent(id);
          }}
        />
      ) : null}
    </>
  );
  return { api: actions, node };
}

/** 予定を Calendar.app で開く（予定のパネルと同じ API） */
async function openEvent(id: string, onFail: () => void): Promise<void> {
  try {
    const r = await unwrap<{ outcome: string }>(
      api.api["calendar-events"][":id"].open.$post({ param: { id } }),
    );
    if (r.outcome === "failed") onFail();
  } catch {
    onFail();
  }
}

/**
 * 空き枠の右クリックメニュー（5.P3 の表）: ここにタスク / 予定を作る、集中モードを始める（キーは keymap と同じ）
 */
export function slotMenu(
  t: (k: MessageKey) => string,
  create: (as: "task" | "event") => void,
): MenuEntry[] {
  const focus = (id: string, label: MessageKey, sep = false): MenuEntry => ({
    id,
    label: t(label),
    keys: keyHint(id) || undefined,
    sep,
    icon: MENU_ICON.focus,
    run: () => void dispatchKey(id),
  });
  return [
    {
      id: "newTask",
      label: t("menu.newTaskHere"),
      keys: keyHint("new"),
      icon: MENU_ICON.newTask,
      run: () => create("task"),
    },
    {
      id: "newEvent",
      label: t("menu.newEventHere"),
      keys: keyHint("newEvent"),
      icon: MENU_ICON.newEvent,
      run: () => create("event"),
    },
    focus("focus30", "keys.focus30", true),
    focus("focus60", "keys.focus60"),
    focus("focusEvent", "keys.focusEvent"),
  ];
}

/** 範囲選択（⇧ クリック）: 並びの中で from から to まで */
export function rangeKeys(order: readonly string[], from: string | null, to: string): string[] {
  const j = order.indexOf(to);
  if (j < 0) return [to];
  const i = from ? order.indexOf(from) : -1;
  if (i < 0) return [to];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** ⌘ クリック: 今の選択（複数選択が無ければ選んでいる1件）に加える・外す */
export function toggleKey(multi: readonly string[], sel: string | null, k: string): string[] {
  const base = multi.length > 0 ? [...multi] : sel && sel !== k ? [sel] : [];
  return base.includes(k) ? base.filter((x) => x !== k) : [...base, k];
}
