/**
 * 図つきの問い（MCP の ask_user。ADR 0022。ux-mvp 4.23）の節: 自分の番の詳細とボードの AI の詳細に出す。中身は開いた瞬間に
 * デーモンのメモリから読み（GET /api/asks/:id）、閉じたら捨てる。
 *
 * - 広いとき（節の幅 520px 以上。パネルを広げたとき）は 2 列: 左に問い・背景・案のカード・メモ・返すボタン、右に AI の説明（図）。狭いときは説明を
 *   下に回す。説明が無ければ右の列は出さない
 * - 案のカード: 番号のキー、名前、推奨（無彩色のチップ。状態の色は使わない）、説明、案の図（右）。図を読めなければ 1 行で
 *   「図を読めませんでした」と出し、案は選べる。図を押すとその図だけを大きく出す（案は選ばない）
 * - 見出しの右に「広げる」（f）: ウインドウのほぼ全体に広げる（AskOverlay.tsx）。選んだ案とメモはパネルと共有（lib/ask-expand.ts）
 * - キー: 1〜4 で選ぶ（入力欄の外）、⌘⏎ で返す。メモだけでも返せる。広げている間はパネルの節はキーを受けない
 * - 返した後は「10:25 に返しました」をカードが動くまで残す（web の状態だけ）。問いが消えた・閉じた・AI 側で打ち切られたら
 *   「もう進んでいます」
 * - 図は sandbox と CSP の枠（FigureFrame）の中。スクリプトは動かず、外へは何も出ない
 */
import type { AskFigureView, AskView } from "@turnlane/core/web";
import { ASK_NOTE_MAX, fmtClock } from "@turnlane/core/web";
import { Maximize2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAsk, useAskSent } from "../data/ask.ts";
import { useQueue } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import {
  askKeyAction,
  canSendAsk,
  dropAskDraft,
  getAskOverlay,
  openAskFigure,
  openAskOverlay,
  sendAskDraft,
  setAskDraft,
  toggleAskChoice,
  useAskDraft,
} from "../lib/ask-expand.ts";
import { isTextEntry } from "../lib/editable.ts";
import { isImeKey } from "../lib/ime.ts";
import { FigureFrame } from "./FigureFrame.tsx";
import { tipProps } from "./Tooltip.tsx";
import { Button, Kbd } from "./ui.tsx";

export function AskSection({ askId, workItemId }: { askId: string; workItemId: string | null }) {
  const { t } = useI18n();
  const q = useAsk(askId);
  const sentAt = useAskSent(askId);
  const tz = useQueue().data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const v = q.data;
  // 閉じた問いの下書き（選んだ案・メモ）は捨てる
  const closed = q.isError || (v !== undefined && v.state !== "open");
  useEffect(() => {
    if (closed) dropAskDraft(askId);
  }, [closed, askId]);
  return (
    <section
      className="@container flex flex-col gap-3 border-line border-t pt-4"
      data-testid="ask"
      data-state={v?.state ?? (q.isError ? "gone" : "loading")}
      aria-label={t("ask.title")}
    >
      <AskStatus v={v} isError={q.isError} sentAt={sentAt} tz={tz} />
      {v?.state === "open" ? (
        <AskBody key={askId} v={v} workItemId={workItemId} layout="panel" />
      ) : null}
    </section>
  );
}

/** 「返しました」「もう進んでいます」「読み込み中」の 1 行（パネルと広げた画面で同じ） */
export function AskStatus({
  v,
  isError,
  sentAt,
  tz,
}: {
  v: AskView | undefined;
  isError: boolean;
  sentAt: number | null;
  tz: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {sentAt !== null ? (
        <p className="text-fg2 text-meta" data-testid="ask-sent">
          {t("ask.sent", { time: fmtClock(sentAt, tz) })}
        </p>
      ) : null}
      {!v ? (
        isError ? (
          <p className="text-fg3 text-meta" data-testid="ask-gone">
            {t("answer.closed")}
          </p>
        ) : (
          <p className="text-fg3 text-meta">{t("answer.loading")}</p>
        )
      ) : v.state !== "open" ? (
        sentAt !== null ? null : v.state === "answered" && v.closedAt !== null ? (
          <p className="text-fg2 text-meta" data-testid="ask-sent">
            {t("ask.sent", { time: fmtClock(v.closedAt, tz) })}
          </p>
        ) : (
          <p className="text-fg3 text-meta" data-testid="ask-gone">
            {t("answer.closed")}
          </p>
        )
      ) : null}
    </>
  );
}

/** 他の浮いた部品（メニュー・パレット・確認）が開いているか（そのときの f は広げない） */
function floating(): boolean {
  return document.querySelector('[role="dialog"],[role="menu"],[role="alertdialog"]') !== null;
}

/**
 * 問いの中身（問い・案・メモ・返す・説明）。layout が panel ならパネルの節、full なら広げた画面の中（AskOverlay）。
 * 選んだ案とメモは問いごとの共有の下書き（広げても戻しても消えない）
 */
export function AskBody({
  v,
  workItemId,
  layout,
}: {
  v: AskView;
  workItemId: string | null;
  layout: "panel" | "full";
}) {
  const { t } = useI18n();
  const options = v.options ?? [];
  const draft = useAskDraft(v.id);
  const can = canSendAsk(draft);
  const expandRef = useRef<HTMLButtonElement>(null);
  const send = () => void sendAskDraft(v.id, workItemId);
  // 1〜4 で選ぶ（入力欄の外）、⌘⏎ で返す、f で広げる（パネルの節だけ）。画面のキー（⌘⏎ = 詳細を開く）より先に受ける。
  // 広げている間はパネルの節は受けない（広げた画面の中の節が受ける）
  const ctx = useRef({ v, workItemId, options, layout });
  ctx.current = { v, workItemId, options, layout };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      const c = ctx.current;
      const open = getAskOverlay();
      if (c.layout === "panel" ? open !== null : open?.figure !== null) return;
      const a = askKeyAction(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          inText: isTextEntry(e.target),
        },
        c.layout === "panel" ? "panel" : "full",
        c.options.length,
      );
      if (!a || a.kind === "back") return;
      if (a.kind === "expand" && floating()) return;
      e.preventDefault();
      e.stopPropagation();
      if (a.kind === "send") void sendAskDraft(c.v.id, c.workItemId);
      else if (a.kind === "expand") openAskOverlay(c.v.id, c.workItemId, expandRef.current);
      else {
        const o = c.options[a.n - 1];
        if (o) setAskDraft(c.v.id, { choice: o.label });
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  const explain = v.explain;
  const full = layout === "full";
  const figureSize = !full ? "sm" : explain ? "md" : "lg";
  const main = (
    <div className={`flex min-w-0 flex-col ${full ? "gap-4" : "gap-3"}`} data-testid="ask-main">
      <div className="flex flex-col gap-1">
        {full ? null : (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px] text-fg3">{t("ask.title")}</span>
            <button
              ref={expandRef}
              type="button"
              onClick={(e) => openAskOverlay(v.id, workItemId, e.currentTarget)}
              className="-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg"
              {...tipProps(t("ask.expand"), "f")}
              data-testid="ask-expand"
            >
              <Maximize2 size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        )}
        <p
          className={`break-words font-semibold text-fg ${full ? "text-[20px] leading-7" : "text-section"}`}
          data-testid="ask-question"
        >
          {v.question}
        </p>
        {v.context ? (
          <p className="break-words text-body text-fg2" data-testid="ask-context">
            {v.context}
          </p>
        ) : null}
      </div>
      <div
        role="radiogroup"
        aria-label={t("ask.options")}
        className="flex flex-col gap-2"
        data-testid="ask-options"
      >
        {options.map((o) => (
          <OptionCard
            key={o.n}
            n={o.n}
            label={o.label}
            description={o.description}
            recommended={o.recommended}
            figure={o.figure}
            size={figureSize}
            on={draft.choice === o.label}
            onPick={() => toggleAskChoice(v.id, o.label)}
            onEnlarge={(el) => openAskFigure(v.id, workItemId, o.n, el)}
          />
        ))}
      </div>
      <textarea
        rows={full ? 3 : 2}
        value={draft.note}
        onChange={(e) => setAskDraft(v.id, { note: e.target.value })}
        aria-label={t("ask.notePlaceholder")}
        placeholder={t("ask.notePlaceholder")}
        maxLength={ASK_NOTE_MAX}
        className="min-h-[52px] w-full min-w-0 resize-y rounded-control border border-line bg-sunken px-2.5 py-1.5 text-body text-fg placeholder:text-fg3 focus:border-fg3"
        style={{ outline: "none" }}
        data-testid="ask-note"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 font-mono text-[11px] text-fg3" data-testid="ask-hint">
          {t(full ? "ask.hintExpanded" : "ask.hint", { n: options.length })}
        </span>
        <Button
          variant="primary"
          className="px-2"
          disabled={!can}
          onClick={send}
          data-testid="ask-send"
        >
          {draft.busy ? t("ask.sending") : t("ask.send")}
          <span className="font-mono text-micro opacity-70">⌘⏎</span>
        </Button>
      </div>
    </div>
  );
  const aside = explain ? (
    <aside
      className={`flex min-w-0 flex-col gap-2 ${full ? "@[960px]:min-h-0 @[960px]:flex-1" : ""}`}
      data-testid="ask-explain"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="font-semibold text-fg2 text-meta">{t("ask.explain")}</h3>
        <span className="min-w-0 truncate text-[11px] text-fg3">{t("ask.explainNote")}</span>
      </div>
      {"html" in explain ? (
        <FigureFrame
          html={explain.html}
          title={t("ask.explain")}
          className={
            full
              ? "h-[70vh] w-full rounded-card border border-line border-dashed @[960px]:h-auto @[960px]:min-h-0 @[960px]:flex-1"
              : "h-[420px] w-full rounded-card border border-line border-dashed"
          }
          testId="ask-explain-frame"
          focusable={!full}
        />
      ) : (
        <p className="text-fg3 text-meta" data-testid="ask-figure-error">
          {t("ask.figureError")}
        </p>
      )}
    </aside>
  ) : null;
  if (full) {
    // 広げた画面: 説明があれば左に問い・右に説明（狭いと縦に積む）。無ければ中央の 1 列で案の図を大きく
    return explain ? (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @[960px]:grid @[960px]:grid-cols-[minmax(360px,1fr)_minmax(0,1.5fr)] @[960px]:overflow-hidden"
        data-testid="ask-full"
        data-layout="split"
      >
        <div className="min-w-0 p-6 @[960px]:min-h-0 @[960px]:overflow-y-auto">{main}</div>
        <div className="flex min-w-0 flex-col border-line border-t p-6 @[960px]:min-h-0 @[960px]:border-t-0 @[960px]:border-l">
          {aside}
        </div>
      </div>
    ) : (
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        data-testid="ask-full"
        data-layout="single"
      >
        <div className="mx-auto w-full max-w-[760px] p-6">{main}</div>
      </div>
    );
  }
  return (
    <div
      className={`grid min-w-0 gap-4 ${explain ? "@[520px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" : ""}`}
    >
      {main}
      {aside}
    </div>
  );
}

/** 案の図の大きさ: sm はパネル（112×80）、md は広げた 2 列（160×112）、lg は広げた 1 列（カードの幅いっぱい・高さ 240） */
type FigureSize = "sm" | "md" | "lg";

const FIGURE_BOX: Record<FigureSize, string> = {
  sm: "h-20 w-28",
  md: "h-28 w-40",
  lg: "h-60 w-full",
};

function OptionCard({
  n,
  label,
  description,
  recommended,
  figure,
  size,
  on,
  onPick,
  onEnlarge,
}: {
  n: number;
  label: string;
  description: string;
  recommended: boolean;
  figure: AskFigureView | undefined;
  size: FigureSize;
  on: boolean;
  onPick: () => void;
  onEnlarge: (opener: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const lg = size === "lg";
  return (
    // biome-ignore lint/a11y/useSemanticElements: カードの中に図の枠（iframe）を持つので input の radio にできない
    <div
      role="radio"
      aria-checked={on}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " " || e.key === "Enter") {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          onPick();
        }
      }}
      className={`grid min-w-0 cursor-pointer items-center gap-3 rounded-card border px-3 py-2.5 transition-colors ${
        lg ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_auto]"
      } ${on ? "border-fg bg-task" : "border-line bg-raised hover:border-fg3"}`}
      data-testid="ask-option"
      data-on={on ? "1" : undefined}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Kbd>{n}</Kbd>
          <span className="min-w-0 break-words font-semibold text-body text-fg">{label}</span>
          {recommended ? (
            <span
              className="rounded-chip bg-fg2 px-1.5 font-medium text-[11px] text-bg leading-4"
              data-testid="ask-recommended"
            >
              {t("ask.recommended")}
            </span>
          ) : null}
        </div>
        <p className="break-words text-fg2 text-meta">{description}</p>
        {figure && !("html" in figure) ? (
          <p className="text-fg3 text-meta" data-testid="ask-figure-error">
            {t("ask.figureError")}
          </p>
        ) : null}
      </div>
      {figure && "html" in figure ? (
        // 図を押すとその図だけを大きく出す。案は選ばない（カードの押す・Space・⏎ に渡さない）
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEnlarge(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") e.stopPropagation();
          }}
          className={`block shrink-0 cursor-zoom-in rounded-[6px] ${FIGURE_BOX[size]}`}
          {...tipProps(t("ask.enlargeFigure", { label }))}
          data-testid="ask-option-zoom"
        >
          <FigureFrame
            html={figure.html}
            title={t("ask.figureTitle", { label })}
            className="pointer-events-none h-full w-full rounded-[6px] border border-line bg-sunken"
            testId="ask-option-frame"
            focusable={false}
          />
        </button>
      ) : null}
    </div>
  );
}
