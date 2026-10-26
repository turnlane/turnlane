/**
 * メニューバーのポップオーバー（/tray。desktop-shell.md 4.2。確定デザインのメニューバー M1）。デスクトップアプリの小さなウインドウ
 * （360×480）に出す。
 * - 上部: `自分の番 3 · ブロック中 1`（自分の番は常にブロック中を含む合計）と右の「Turnlane を開く」。一覧は needs_input → error →
 *   your_turn、待ちの長い順で最大8行＋`+N more`。行は2行（題名 / リポジトリ · 待ち）、右に開く先のアプリのアイコン、ホバーで
 *   明日へ・スヌーズ・対応不要。色は状態アイコンだけ
 * - 行の操作: ⏎ / クリック = 開く（engage + 外部を開く。M2-6 と同じ）、e = 対応不要、m = 明日（次の稼働日の計画の目安の開始まで。D-052 (1)）、↑↓ で選択
 * - 下部: 週ボードを開く、クイック入力（一日を閉じるの行は D-192 で廃止）
 * - 上部の下: 会議の前の問い（集中する / しない。D-097）
 * - 一番上: 集中中は画面上部と同じ藍の帯（`集中モード · 15:30 まで · 残り 30m`、止めた通知の件数、「終了」。ux-mvp 4.15）
 * - 下部の先頭: 拡張の行（ADR 0015。trayItems）、その下に集中していなければ「集中する ▸」（30分 / 1時間 / 次の予定の
 *   終わりまで。⌘K・メニューバーの右クリックと同じ。D-130。集中中は一番上の帯に任せて出さない）
 * - 表示のたび（ウインドウにフォーカスが来るたび）にキューを取り直す
 */
import {
  countedTurns,
  isGrace,
  nextWeekday,
  primaryFollowUp,
  type QueueItem,
  turnRows,
} from "@turnlane/core/web";
import { CalendarCheck, ChevronRight, CircleDot, Plus, Settings, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type ItemActionsApi,
  ItemActionsProvider,
  useItemActionsHost,
} from "../actions/item-actions.tsx";
import { type Prompt, PromptView } from "../board/editors.tsx";
import { AwayLine, useAwayDigest } from "../components/AwayLine.tsx";
import { FocusActiveBand, FocusBar } from "../components/FocusBar.tsx";
import { useOpenWith } from "../components/OpenWith.tsx";
import { TurnRow } from "../components/TurnRow.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { queryClient } from "../data/client.ts";
import { keys } from "../data/invalidate.ts";
import {
  completeFollowUp,
  deferFollowUp,
  dismissAway,
  dismissFollowUps,
  openTask,
  snoozeFollowUp,
  startFocus,
} from "../data/mutations.ts";
import { useDesktopStatus, useFocus, useQueue } from "../data/queries.ts";
import { ext } from "../ext/registry.ts";
import { useI18n } from "../i18n/index.tsx";
import { useGlobalKeys, useKeys } from "../keys/use-keys.ts";
import { useNow } from "../lib/clock.ts";
import {
  desktopHide,
  desktopOpen,
  desktopQuickAdd,
  panelPath,
  shortcutLabel,
} from "../lib/desktop.ts";
import type { SelItem } from "../lib/store.ts";

const MAX_ROWS = 8;

export function TrayPage() {
  const { t } = useI18n();
  const q = useQueue();
  // 自分の番の行（猶予中の問いを末尾に薄く。D-245）。見出しの数は猶予中を含めない
  const items = turnRows(q.data?.items, q.data?.grace);
  const [cur, setCur] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const now = useNow();
  const tz = q.data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shown = items.slice(0, MAX_ROWS);
  const sel: QueueItem | undefined = shown[Math.min(cur, shown.length - 1)];
  const shortcut = useDesktopStatus().data?.app?.shortcut.accelerator;
  const away = useAwayDigest();
  useGlobalKeys();
  useEffect(() => {
    const onFocus = () => {
      setCur(0);
      void queryClient.invalidateQueries({ queryKey: keys.queue() });
      void queryClient.invalidateQueries({ queryKey: keys.focus() });
      void queryClient.invalidateQueries({ queryKey: keys.away() });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const open = (x: QueueItem | undefined) => {
    if (!x) return false;
    const f = primaryFollowUp(x);
    // 猶予中の問い（D-245）は返答タスクが無いので項目の既定の開き先
    void openTask(f ? { followUpId: f.id } : { workItemId: x.workItemId });
    desktopHide();
    return true;
  };
  const openWith = useOpenWith(desktopHide);
  const answerOn = useAnswerEnabled();
  const go = (path: string) => () => {
    desktopOpen(path);
    return true;
  };
  useKeys({
    next: () => {
      setCur((c) => Math.min(shown.length - 1, c + 1));
      return true;
    },
    prev: () => {
      setCur((c) => Math.max(0, c - 1));
      return true;
    },
    open: () => open(sel),
    openWith: () => {
      const f = sel ? primaryFollowUp(sel) : undefined;
      if (!sel || !f) return false;
      openWith.show(
        document.querySelector<HTMLElement>(
          `[data-kind="turn"][data-id="${CSS.escape(sel.workItemId)}"]`,
        ),
        { followUpId: f.id },
      );
      return true;
    },
    // a: main ウインドウを出して、詳細パネルの「答える」の節を開く（D-238）
    answer: () => {
      if (!sel || !answerOn || !answerable(sel)) return false;
      desktopOpen(panelPath(sel.workItemId, { answer: true }));
      desktopHide();
      return true;
    },
    // → / ⌘⏎: main ウインドウを出して AI 詳細パネルを開く（D-067。desktop-shell.md 4.2）
    detail: () => {
      if (!sel) return false;
      desktopOpen(panelPath(sel.workItemId));
      desktopHide();
      return true;
    },
    dismiss: () => {
      const f = sel ? primaryFollowUp(sel) : undefined;
      if (!f) return false;
      void dismissFollowUps([f.id]);
      return true;
    },
    // 完了とスヌーズ（行のチェックとホバーのボタン。UX 監査 A2）
    complete: () => {
      const f = sel ? primaryFollowUp(sel) : undefined;
      if (!f) return false;
      void completeFollowUp(f.id);
      return true;
    },
    snooze: () => {
      const f = sel ? primaryFollowUp(sel) : undefined;
      if (!sel || !f) return false;
      setPrompt({
        kind: "snooze",
        anchor: document.querySelector<HTMLElement>(
          `[data-kind="turn"][data-id="${CSS.escape(sel.workItemId)}"]`,
        ),
        onSubmit: (p) => void snoozeFollowUp(f.id, p),
      });
      return true;
    },
    move: () => {
      const f = sel ? primaryFollowUp(sel) : undefined;
      const today = q.data?.today;
      if (!f || !today) return false;
      void deferFollowUp(f.id, nextWeekday(today));
      return true;
    },
    escape: () => {
      desktopHide();
      return true;
    },
    goQueue: go("/queue"),
    goBoard: go("/board"),
    goInbox: go("/inbox"),
    goAi: go("/ai"),
    goSettings: go("/settings"),
    goRecord: go("/day?record=1"),
  });
  // マウスの操作（UX 監査 A2）: チェックで完了、ホバーのボタン（開く・明日へ・スヌーズ・対応不要・…）、右クリック。
  // 行のクリックは開く（desktop-shell.md 4.2）。詳細は main ウインドウのパネル
  const host = useItemActionsHost({
    select: (k) => {
      const i = shown.findIndex((x) => `turn:${x.workItemId}` === k);
      if (i >= 0) setCur(i);
    },
    inMulti: () => false,
    itemsFor: (k) =>
      shown
        .filter((x) => `turn:${x.workItemId}` === k)
        .map((item): SelItem => ({ kind: "turn", item })),
    openDetail: (k) => {
      desktopOpen(panelPath(k.slice(5)));
      desktopHide();
    },
  });
  const n = (s: string) => items.filter((x) => !isGrace(x) && x.status === s).length;
  const extra = [
    ["needs_input", n("needs_input")],
    ["error", n("error")],
  ] as const;
  const row =
    "flex h-9 w-full items-center gap-3 rounded-card px-3 text-left text-body text-fg hover:bg-sunken";
  return (
    <ItemActionsProvider value={host.api}>
      <div className="flex h-screen flex-col overflow-hidden bg-raised text-fg">
        {/* 集中中の帯（ux-mvp 4.15。画面上部と同じ藍の帯）。一番上に出す */}
        <FocusActiveBand compact />
        <header className="flex items-baseline gap-1 px-4 pt-4 pb-2">
          <h1 className="font-semibold text-[14px] text-fg" data-testid="tray-title">
            {t("tray.title")} <span>{countedTurns(items)}</span>
          </h1>
          {extra
            .filter(([, c]) => c > 0)
            .map(([k, c]) => (
              <span key={k} className="text-[14px] text-fg2">
                {" · "}
                {t(k === "needs_input" ? "queue.filter.blocked" : `status.${k}`)} <span>{c}</span>
              </span>
            ))}
          <button
            type="button"
            className="ml-auto shrink-0 text-body text-fg2 hover:text-fg"
            onClick={go("/board")}
            data-testid="tray-open-app"
          >
            {t("tray.openApp", { app: t("app.name") })}
          </button>
        </header>
        {/* 離れていた間のまとめ（D-214 (2)）。件を開くと待ちは端末へ、ほかは詳細パネル。開いたらまとめは閉じる */}
        <AwayLine
          digest={away}
          tz={tz}
          now={now}
          variant="tray"
          onOpen={(x, d) => {
            void dismissAway(d.key);
            if (x.followUpId) void openTask({ followUpId: x.followUpId });
            else desktopOpen(panelPath(x.workItemId));
            desktopHide();
          }}
        />
        {/* 一覧の高さは中身に合わせ、下の操作を一覧のすぐ下に置く（確定デザインのメニューバー。D-114） */}
        <div className="flex min-h-0 shrink flex-col gap-0.5 overflow-y-auto px-2">
          {items.length === 0 && q.isSuccess ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center">
              <p className="font-medium text-body text-fg">{t("queue.emptyTitle")}</p>
              <p className="text-fg2 text-meta">{t("queue.emptyHint")}</p>
            </div>
          ) : null}
          {shown.map((x, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: ホバーで選ぶ（キーは ↑↓）
            <div key={x.workItemId} onMouseEnter={() => setCur(i)}>
              <TurnRow
                item={x}
                now={now}
                tz={tz}
                variant="compact"
                roomy={shown.length <= 3}
                selected={false}
                onClick={() => open(x)}
                onOpen={() => open(x)}
              />
            </div>
          ))}
          {items.length > MAX_ROWS ? (
            <button
              type="button"
              className="self-start px-3 py-1 text-fg2 text-meta hover:text-fg"
              onClick={go("/queue")}
            >
              {t("tray.more", { count: items.length - MAX_ROWS })}
            </button>
          ) : null}
        </div>
        <div className="mx-3 my-2 h-px bg-line" />
        {/* 会議の前の問い（D-097） */}
        <FocusBar where="tray" />
        <div className="flex flex-col px-2 pb-3">
          {/* 拡張の行（ADR 0015。集中の行の上）。公開のビルドでは何も出ない */}
          {ext.trayItems.map((x) => (
            <x.component key={x.key} />
          ))}
          <FocusRow row={row} menu={host.api} />
          <button
            type="button"
            className={row}
            onClick={() => desktopQuickAdd()}
            data-testid="tray-add"
            title={t("tray.addHint", { key: shortcutLabel(shortcut) })}
          >
            <Plus size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
            <span className="flex-1">{t("tray.addTask")}</span>
            <span className="font-mono text-fg3 text-micro">{shortcutLabel(shortcut)}</span>
          </button>
          <button type="button" className={row} onClick={go("/settings")}>
            <Settings size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
            <span className="flex-1">{t("nav.settings")}</span>
          </button>
        </div>
        {openWith.menu}
        {host.node}
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

/**
 * 集中モードの行（D-130。確定デザインのメニューバー R18）。集中中は出さない（一番上の帯）。集中していなければ「集中する ▸」で 30分 / 1時間 / 次の予定の終わりまで（予定が無ければ出さない）を選ぶ
 */
function FocusRow({ row, menu }: { row: string; menu: ItemActionsApi }) {
  const { t } = useI18n();
  const f = useFocus().data;
  if (!f) return null;
  // 集中中は一番上の帯（FocusActiveBand）に表示と「終了」がある
  if (f.active) return null;
  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const item = (id: string, label: string, icon: typeof Timer, run: () => void) => ({
      id,
      label,
      icon,
      run,
    });
    // 行の右（▸ の下）に揃えて出す（メニューの幅 240px。入らなければ ContextMenu が左へ寄せる）
    menu.openMenu(r.right - 240, r.bottom - 4, [
      item("focus30", t("focus.m30"), Timer, () => void startFocus({ minutes: 30 })),
      item("focus60", t("focus.h1"), Timer, () => void startFocus({ minutes: 60 })),
      ...(f.nextEventEnd !== null
        ? [
            item(
              "focusEvent",
              t("focus.untilEvent"),
              CalendarCheck,
              () => void startFocus({ until: "event_end" }),
            ),
          ]
        : []),
    ]);
  };
  return (
    <button
      type="button"
      className={row}
      aria-haspopup="menu"
      onClick={(e) => open(e.currentTarget)}
      data-testid="tray-focus-start"
    >
      <CircleDot size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
      <span className="flex-1">{t("focus.start")}</span>
      <ChevronRight size={14} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
    </button>
  );
}
