/**
 * 図つきの問い（MCP の ask_user。ADR 0022。ux-mvp 4.23）の節: 自分の番の詳細とボードの AI の詳細に出す。中身は開いた瞬間に
 * デーモンのメモリから読み（GET /api/asks/:id）、閉じたら捨てる。
 *
 * - 広いとき（節の幅 520px 以上。パネルを広げたとき）は 2 列: 左に問い・背景・案のカード・メモ・返すボタン、右に AI の説明（図）。狭いときは説明を
 *   下に回す。説明が無ければ右の列は出さない
 * - 案のカード: 番号のキー、名前、推奨（無彩色のチップ。状態の色は使わない）、説明、案の図（右）。図を読めなければ 1 行で
 *   「図を読めませんでした」と出し、案は選べる
 * - キー: 1〜4 で選ぶ（入力欄の外）、⌘⏎ で返す。メモだけでも返せる
 * - 返した後は「10:25 に返しました」をカードが動くまで残す（web の状態だけ）。問いが消えた・閉じた・AI 側で打ち切られたら
 *   「もう進んでいます」
 * - 図は sandbox と CSP の枠（FigureFrame）の中。スクリプトは動かず、外へは何も出ない
 */
import type { AskFigureView, AskView } from "@turnlane/core/web";
import { ASK_NOTE_MAX, fmtClock } from "@turnlane/core/web";
import { useCallback, useEffect, useRef, useState } from "react";
import { sendAsk, useAsk, useAskSent } from "../data/ask.ts";
import { useQueue } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { isTextEntry } from "../lib/editable.ts";
import { isImeKey } from "../lib/ime.ts";
import { FigureFrame } from "./FigureFrame.tsx";
import { Button, Kbd } from "./ui.tsx";

export function AskSection({ askId, workItemId }: { askId: string; workItemId: string | null }) {
  const { t } = useI18n();
  const q = useAsk(askId);
  const sentAt = useAskSent(askId);
  const tz = useQueue().data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const v = q.data;
  return (
    <section
      className="@container flex flex-col gap-3 border-line border-t pt-4"
      data-testid="ask"
      data-state={v?.state ?? (q.isError ? "gone" : "loading")}
      aria-label={t("ask.title")}
    >
      {sentAt !== null ? (
        <p className="text-fg2 text-meta" data-testid="ask-sent">
          {t("ask.sent", { time: fmtClock(sentAt, tz) })}
        </p>
      ) : null}
      {!v ? (
        q.isError ? (
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
      ) : (
        <AskBody key={askId} v={v} workItemId={workItemId} />
      )}
    </section>
  );
}

function AskBody({ v, workItemId }: { v: AskView; workItemId: string | null }) {
  const { t } = useI18n();
  const options = v.options ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const can = !busy && (choice !== null || note.trim().length > 0);
  const send = useCallback(async () => {
    if (!can) return;
    setBusy(true);
    const r = await sendAsk(v.id, workItemId, {
      ...(choice !== null ? { choice } : {}),
      ...(note.trim() ? { note } : {}),
    });
    setBusy(false);
    if (r.ok) setNote("");
  }, [can, choice, note, v.id, workItemId]);
  // 1〜4 で選ぶ（入力欄の外）、⌘⏎ で返す。画面のキー（⌘⏎ = 詳細を開く）より先に受ける
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        void sendRef.current();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
      const n = Number(e.key);
      const o = Number.isInteger(n) ? options[n - 1] : undefined;
      if (!o) return;
      e.preventDefault();
      e.stopPropagation();
      setChoice(o.label);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [options]);
  const explain = v.explain;
  return (
    <div
      className={`grid min-w-0 gap-4 ${explain ? "@[520px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]" : ""}`}
    >
      <div className="flex min-w-0 flex-col gap-3" data-testid="ask-main">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-fg3">{t("ask.title")}</span>
          <p className="break-words font-semibold text-fg text-section" data-testid="ask-question">
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
              on={choice === o.label}
              onPick={() => setChoice(choice === o.label ? null : o.label)}
            />
          ))}
        </div>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label={t("ask.notePlaceholder")}
          placeholder={t("ask.notePlaceholder")}
          maxLength={ASK_NOTE_MAX}
          className="min-h-[52px] w-full min-w-0 resize-y rounded-control border border-line bg-sunken px-2.5 py-1.5 text-body text-fg placeholder:text-fg3 focus:border-fg3"
          style={{ outline: "none" }}
          data-testid="ask-note"
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 font-mono text-[11px] text-fg3">
            {t("ask.hint", { n: options.length })}
          </span>
          <Button
            variant="primary"
            className="px-2"
            disabled={!can}
            onClick={() => void send()}
            data-testid="ask-send"
          >
            {busy ? t("ask.sending") : t("ask.send")}
            <span className="font-mono text-micro opacity-70">⌘⏎</span>
          </Button>
        </div>
      </div>
      {explain ? (
        <aside className="flex min-w-0 flex-col gap-2" data-testid="ask-explain">
          <div className="flex items-baseline gap-2">
            <h3 className="font-semibold text-fg2 text-meta">{t("ask.explain")}</h3>
            <span className="min-w-0 truncate text-[11px] text-fg3">{t("ask.explainNote")}</span>
          </div>
          {"html" in explain ? (
            <FigureFrame
              html={explain.html}
              title={t("ask.explain")}
              className="h-[420px] w-full rounded-card border border-line border-dashed"
              testId="ask-explain-frame"
            />
          ) : (
            <p className="text-fg3 text-meta" data-testid="ask-figure-error">
              {t("ask.figureError")}
            </p>
          )}
        </aside>
      ) : null}
    </div>
  );
}

function OptionCard({
  n,
  label,
  description,
  recommended,
  figure,
  on,
  onPick,
}: {
  n: number;
  label: string;
  description: string;
  recommended: boolean;
  figure: AskFigureView | undefined;
  on: boolean;
  onPick: () => void;
}) {
  const { t } = useI18n();
  return (
    // biome-ignore lint/a11y/useSemanticElements: カードの中に図の枠（iframe）を持つので input の radio にできない
    <div
      role="radio"
      aria-checked={on}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          onPick();
        }
      }}
      className={`grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-card border px-3 py-2.5 transition-colors ${
        on ? "border-fg bg-task" : "border-line bg-raised hover:border-fg3"
      }`}
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
        <FigureFrame
          html={figure.html}
          title={t("ask.figureTitle", { label })}
          className="pointer-events-none h-20 w-28 rounded-[6px] border border-line bg-sunken"
          testId="ask-option-frame"
        />
      ) : null}
    </div>
  );
}
