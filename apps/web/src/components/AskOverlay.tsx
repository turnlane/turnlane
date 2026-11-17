/**
 * 図つきの問い（ADR 0022。ux-mvp 4.23）を広げた画面。ウインドウのほぼ全体を覆うモーダル（画面の外枠に 1 つ。AppShell）:
 *
 * - 全体（full）: 左に問い・背景・案のカード・メモ・返すボタン、右に AI の説明を大きく（中でスクロール）。説明が無ければ中央の
 *   1 列で案の図を大きく。狭いウインドウでは縦に積む。キーと動きはパネルの節と同じ（AskBody を layout="full" で使う）。
 *   選んだ案とメモはパネルと共有。返したら閉じる
 * - 案の図 1 枚（figure）: 押した図だけを大きく。Esc で元へ（全体から開いたら全体、パネルから開いたらパネル）
 * - モーダル: 背景は inert、Tab は枠の中を回る、Esc（と閉じるボタン・背景の押下）で 1 段戻り、開いた部品へフォーカスを返す。
 *   画面のキー（j・k・e・Space など）は背景に届かない。大きな図の枠を押してフォーカスが枠の中へ移ったら枠の外へ戻す
 *   （枠の中のキーは画面に届かず Esc が効かなくなるため。スクロールはホイールで効く）
 * - 広げている間に問いが閉じたら（ほかで返した・AI 側で打ち切られた・消えた）、パネルと同じ言葉を出し、Esc・閉じるで閉じる
 * - 図の枠は今と同じ sandbox と CSP（FigureFrame）
 */
import type { AskView } from "@turnlane/core/web";
import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { askKey, useAsk, useAskSent } from "../data/ask.ts";
import { queryClient } from "../data/client.ts";
import { useQueue } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import {
  type AskOverlayState,
  backAskOverlay,
  dropAskDraft,
  focusBack,
  takeAskFocus,
  trapIndex,
  useAskOverlay,
} from "../lib/ask-expand.ts";
import { isImeKey } from "../lib/ime.ts";
import { AskBody, AskStatus } from "./AskSection.tsx";
import { FigureFrame } from "./FigureFrame.tsx";
import { tipProps } from "./Tooltip.tsx";
import { Button, Kbd } from "./ui.tsx";

export function AskOverlay() {
  const s = useAskOverlay();
  if (!s) return null;
  return createPortal(<AskOverlayHost key={s.askId} s={s} />, document.body);
}

function AskOverlayHost({ s }: { s: AskOverlayState }) {
  const q = useAsk(s.askId);
  const sentAt = useAskSent(s.askId);
  const queue = useQueue().data;
  const tz = queue?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 自分の番から問いの行が消えたら（ほかで返した・閉じた・打ち切られた）問いを読み直す。パネルの節は消えても、ここは残って言葉を出す
  const listed = queue
    ? queue.items.some((x) => x.followUps.some((f) => f.askUser === s.askId))
    : null;
  useEffect(() => {
    if (listed === false) void queryClient.invalidateQueries({ queryKey: askKey(s.askId) });
  }, [listed, s.askId]);
  const v = q.data;
  const closed = q.isError || (v !== undefined && v.state !== "open");
  useEffect(() => {
    if (closed) dropAskDraft(s.askId);
  }, [closed, s.askId]);
  return <AskOverlayView s={s} v={v} isError={q.isError} sentAt={sentAt} tz={tz} />;
}

const FOCUSABLE =
  'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

/** 広げた画面の見た目と動き（状態は外から。テストでも使う） */
export function AskOverlayView({
  s,
  v,
  isError,
  sentAt,
  tz,
}: {
  s: AskOverlayState;
  v: AskView | undefined;
  isError: boolean;
  sentAt: number | null;
  tz: string;
}) {
  const { t } = useI18n();
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = v?.state === "open" ? v : undefined;
  const option =
    s.figure !== null ? (open?.options ?? []).find((o) => o.n === s.figure) : undefined;
  const view = s.figure !== null ? "figure" : "full";

  // 背景を inert にする（開いている間だけ。もとから inert のものには触れない）
  useEffect(() => {
    const me = backdrop.current;
    if (!me) return;
    const set: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === me || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      set.push(el);
    }
    return () => {
      for (const el of set) el.removeAttribute("inert");
      // 閉じた: inert を外した後で、開いた部品へフォーカスを返す
      focusBack(takeAskFocus());
    };
  }, []);

  // 開いたとき・全体と図を行き来したとき、フォーカスが枠の外（消えた部品・背景）なら枠に置く（キーが画面に届く）。
  // 図から全体へ戻ったときは、図を開いた部品へ返す（lib/ask-expand.ts の takeAskFocus）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 段が変わったときに置き直す
  useEffect(() => {
    if (focusBack(takeAskFocus())) return;
    const box = dialog.current;
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
  }, [view, s.figure]);

  // Esc で 1 段戻る、Tab は枠の中を回る、枠の外（body など）から来たキーは画面に渡さない
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      const box = dialog.current;
      if (!box) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        backAskOverlay();
        return;
      }
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const els = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.getClientRects().length > 0,
        );
        const i = trapIndex(
          els.length,
          els.indexOf(document.activeElement as HTMLElement),
          e.shiftKey,
        );
        e.preventDefault();
        e.stopPropagation();
        (els[i] ?? box).focus();
        return;
      }
      if (!(e.target instanceof Node && backdrop.current?.contains(e.target))) e.stopPropagation();
    };
    // 大きな図の枠を押すとフォーカスが枠の中へ移り、キーが画面に届かなくなる。枠の外（モーダルの枠）へ戻す
    const onBlur = () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (a instanceof HTMLIFrameElement && dialog.current?.contains(a))
          dialog.current.focus({ preventScroll: true });
      }, 0);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const title =
    view === "figure" && option ? t("ask.figureTitle", { label: option.label }) : t("ask.title");
  const gone = (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="ask-overlay-closed">
      <div className="flex flex-col items-center gap-3">
        <AskStatus v={v} isError={isError} sentAt={sentAt} tz={tz} />
        <Button onClick={backAskOverlay} data-testid="ask-overlay-dismiss">
          {t("action.close")}
          <Kbd>esc</Kbd>
        </Button>
      </div>
    </div>
  );
  // 全体は図を出している間も隠して残す（スクロールの位置と、図を開いた部品へ戻るフォーカスのため）
  const fullBody =
    s.full && open ? (
      <div className={view === "full" ? "contents" : "hidden"} data-testid="ask-overlay-full">
        <AskBody key={open.id} v={open} workItemId={s.workItemId} layout="full" />
      </div>
    ) : null;
  // 枠の中は 3 つの場所に固定（全体・図・閉じた）。場所を変えると全体が作り直されてしまう
  const figureBody =
    view === "figure" && option?.figure && "html" in option.figure ? (
      <div className="flex min-h-0 flex-1 p-6">
        <FigureFrame
          html={option.figure.html}
          title={t("ask.figureTitle", { label: option.label })}
          className="h-full w-full rounded-card border border-line border-dashed bg-sunken"
          testId="ask-figure-frame"
          focusable={false}
          fit
        />
      </div>
    ) : null;
  const goneBody = (view === "full" ? fullBody : figureBody) ? null : gone;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景の押下で閉じる。キーは画面に渡さない
    <div
      ref={backdrop}
      className="fixed inset-0 z-50 flex bg-black/50 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) backAskOverlay();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      data-testid="ask-overlay-backdrop"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-pop border border-line bg-raised shadow-pop"
        style={{ outline: "none" }}
        data-testid="ask-overlay"
        data-view={view}
      >
        <header className="flex h-11 shrink-0 items-center gap-3 border-line border-b px-4">
          <h2 id={titleId} className="min-w-0 flex-1 truncate font-medium text-body text-fg">
            {title}
          </h2>
          {open && sentAt !== null ? (
            <AskStatus v={open} isError={false} sentAt={sentAt} tz={tz} />
          ) : null}
          <button
            type="button"
            onClick={backAskOverlay}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg"
            {...tipProps(t("action.close"), "esc")}
            data-testid="ask-overlay-close"
          >
            <X size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>
        {fullBody}
        {figureBody}
        {goneBody}
      </div>
    </div>
  );
}
