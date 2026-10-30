/**
 * 「答える」の節（D-238、ADR 0019。ux-mvp 4.18、README R80）: 詳細パネル（ボード）と自分の番の画面の詳細で、行の「答える」・
 * `a` で開く。待ちの中身は開いた瞬間に読み（GET /wait）、閉じたら捨てる。答えの文は送ったら消す（画面に残さない）。
 *
 * - 問い（返答待ち・回答待ち・エラー）: 問いの全文（スクロール。右下のつまみで手で広げられる）、選択肢の番号のボタン（押すと入力欄に番号）、入力欄（⌘⏎ で送る、
 *   ⏎ は改行）、送るボタンに届け先（`送る · Orca · タブ`）
 * - 許可待ち: ツールと中身は上の「待っている理由」に出ている。その下に「許可する」（1 を送る）と「開いて決める」。今後も許可は出さない
 * - 送れない端末: 入力欄を出さず「この端末には送れません」と理由、「開く」
 * - 送った後（D-241）: 節は閉じず、その待ちが閉じるまで「10:25 に送りました · 確認済み」（確かめられなければ「確認できません」）
 *   の 1 行を残す（web の状態だけ）。待ちが閉じると節ごと消える
 */
import type { OpenWaitBrief, WaitResponse } from "@turnlane/core/web";
import { fmtClock } from "@turnlane/core/web";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sendAnswer, sentKey, useSentMark, useWait } from "../data/answer.ts";
import { openTask } from "../data/mutations.ts";
import { useQueue } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { isImeKey } from "../lib/ime.ts";
import { setUi, useUi } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";
import { Button } from "./ui.tsx";

/** その項目の「答える」の節を開く（行の「答える」・`a`） */
export function openAnswer(workItemId: string): void {
  setUi({ answerFor: workItemId });
}

export const closeAnswer = () => setUi({ answerFor: null });

/** その項目の節が開いているか */
export function useAnswerOpen(workItemId: string | null | undefined): boolean {
  const f = useUi((s) => s.answerFor);
  return !!workItemId && f === workItemId;
}

export function AnswerSection({
  workItemId,
  wait,
}: {
  workItemId: string;
  /** 答える対象の待ち（D-240。queue の item の wait / 詳細の openWait） */
  wait: OpenWaitBrief | null | undefined;
}) {
  const open = useAnswerOpen(workItemId);
  if (!open) return null;
  return (
    <AnswerBody
      key={workItemId}
      workItemId={workItemId}
      followUpId={wait?.followUpId ?? null}
      markKey={sentKey(workItemId, wait ?? null)}
    />
  );
}

function AnswerBody({
  workItemId,
  followUpId,
  markKey,
}: {
  workItemId: string;
  followUpId: string | null;
  markKey: string;
}) {
  const { t } = useI18n();
  const sent = useSentMark(markKey);
  const tz = useQueue().data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const q = useWait(workItemId, true);
  const w = q.data;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // 開いたらすぐ書ける（`a` → 入力）
  useEffect(() => {
    if (w?.delivery.deliverable && w.kind !== "permission") area.current?.focus();
  }, [w?.delivery.deliverable, w?.kind]);
  const fid = w?.followUpId ?? followUpId;
  const send = async (input: { text: string } | { allow: true }) => {
    if (busy) return;
    setBusy(true);
    const r = await sendAnswer(workItemId, fid, input, markKey);
    setBusy(false);
    // 送れたら節は閉じず、送った印を残す（待ちが閉じると節ごと消える。D-241）。閉じていた待ちは閉じる
    if (r.ok) setText("");
    else if (r.code === "wait_closed") {
      setText("");
      closeAnswer();
    }
  };
  const openSession = () => {
    // フォローアップの無い待ち（猶予の間の問い。D-240）はカードで開く
    void openTask(fid ? { followUpId: fid } : { workItemId });
  };
  return (
    <section
      className="flex flex-col gap-2 border-line border-t pt-4"
      data-testid="answer"
      aria-label={t("answer.title")}
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 font-semibold text-fg2 text-meta">{t("answer.title")}</h3>
        <button
          type="button"
          aria-label={t("action.close")}
          onClick={closeAnswer}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-fg3 hover:bg-sunken hover:text-fg"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      {sent ? (
        <p className="text-fg2 text-meta" data-testid="answer-sent">
          {t(sent.confirmed ? "answer.sentConfirmed" : "answer.sentUnconfirmed", {
            time: fmtClock(sent.at, tz),
          })}
        </p>
      ) : null}
      {!w ? (
        <p className="text-fg3 text-meta">{q.isError ? t("answer.failed") : t("answer.loading")}</p>
      ) : w.kind === "none" ? (
        // 送った後に読み直したら待ちが閉じていた（行・詳細が読み直されるまでの間）。送った印だけを出す
        sent ? null : (
          <p className="text-fg3 text-meta">{t("answer.closed")}</p>
        )
      ) : w.kind === "ask" && !w.question && w.unavailable && w.unavailable !== "off" ? (
        // AskUserQuestion のダイアログは選択式。問いが読めないと、自由な文は意味がなく、数字は見えない選択肢を選んでしまう
        <div className="flex flex-col gap-2" data-testid="answer-ask-unreadable">
          <p className="text-fg2 text-meta">{t("answer.askUnreadable")}</p>
          <div>
            <Button
              variant="primary"
              className="px-2"
              onClick={openSession}
              data-testid="answer-open"
            >
              {t("answer.open")}
            </Button>
          </div>
        </div>
      ) : w.kind === "permission" ? (
        <PermissionAnswer
          w={w}
          busy={busy}
          onAllow={() => void send({ allow: true })}
          onOpen={openSession}
        />
      ) : (
        <>
          <Question w={w} workItemId={workItemId} />
          {/* 報告の項目（ADR 0021）の選択肢は読めるだけ（答えは報告した側で。v1） */}
          {w.options &&
          w.options.length > 0 &&
          (w.delivery.deliverable || w.delivery.reason === "report") ? (
            <fieldset
              className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
              data-testid="answer-options"
              aria-label={t("answer.options")}
            >
              {w.options.map((o) => (
                <Button
                  key={o.n}
                  size="sm"
                  className="max-w-full"
                  title={t("answer.option", { n: o.n })}
                  data-testid="answer-option"
                  disabled={!w.delivery.deliverable}
                  onClick={() => {
                    setText(String(o.n));
                    area.current?.focus();
                  }}
                >
                  <span className="font-mono">{o.n}</span>
                  <span className="min-w-0 truncate">{o.label}</span>
                </Button>
              ))}
            </fieldset>
          ) : null}
          {w.delivery.deliverable ? (
            <>
              <textarea
                ref={area}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeKey(e)) return;
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (text.trim()) void send({ text });
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeAnswer();
                  }
                }}
                aria-label={t("answer.placeholder")}
                placeholder={t("answer.placeholder")}
                maxLength={4000}
                className="min-h-[72px] w-full min-w-0 resize-y rounded-control border border-line bg-bg px-2.5 py-1.5 text-body text-fg placeholder:text-fg3 focus:border-fg3"
                style={{ outline: "none" }}
                data-testid="answer-input"
              />
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[11px] text-fg3">
                  {t(w.delivery.multiline ? "answer.hint" : "answer.hintFolded")}
                </span>
                <Button
                  variant="primary"
                  className="max-w-[70%] px-2"
                  disabled={busy || !text.trim()}
                  onClick={() => void send({ text })}
                  data-testid="answer-send"
                >
                  <span className="min-w-0 truncate">
                    {busy
                      ? t("answer.sending")
                      : t("answer.sendTo", { where: w.delivery.landing ?? "" })}
                  </span>
                  <span className="font-mono text-micro opacity-70">⌘⏎</span>
                </Button>
              </div>
            </>
          ) : (
            <CantSend w={w} onOpen={openSession} />
          )}
        </>
      )}
    </section>
  );
}

/** 問いの枠を手で広げた高さ（項目ごと。web の状態だけで保存しない。同じ項目を開き直しても保つ） */
const keptQuestionHeight = new Map<string, number>();
/** 問いの枠の既定の上限（これより長い問いは中でスクロール） */
const QUESTION_MAX = 180;

/** 外側のスクロールする枠（詳細パネルの中身） */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/**
 * 問いの本文の枠: 既定は中身の高さ（上限 180px で中でスクロール）。右下のつまみで手で広げられる（自動では広げない）。
 * 最小は開いたときの高さ、上限は答えの節が丸ごとパネルの見える高さに収まるまで（答えの欄とボタンを押し出さない）。
 * 広げている間は節の下端（送るボタン）が見えるようにパネルをスクロールする
 */
function useQuestionResize(workItemId: string, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 問いの枠が出たら（ready）付ける
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.minHeight = `${Math.min(el.offsetHeight, QUESTION_MAX)}px`;
    const kept = keptQuestionHeight.get(workItemId);
    if (kept) {
      el.style.height = `${kept}px`;
      el.style.maxHeight = `${Math.max(kept, QUESTION_MAX)}px`;
    }
    let dragging = false;
    let start = el.offsetHeight;
    const onDown = () => {
      dragging = true;
      start = el.offsetHeight;
      const section = el.closest<HTMLElement>('[data-testid="answer"]');
      const box = scroller(el);
      const room =
        box && section ? box.clientHeight - (section.offsetHeight - el.offsetHeight) - 24 : 0;
      el.style.maxHeight = `${Math.max(room, el.offsetHeight, QUESTION_MAX)}px`;
    };
    const onUp = () => {
      dragging = false;
    };
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!dragging || Math.abs(el.offsetHeight - start) <= 1) return;
            keptQuestionHeight.set(workItemId, el.offsetHeight);
            el.closest('[data-testid="answer"]')?.lastElementChild?.scrollIntoView({
              block: "nearest",
            });
          });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    ro?.observe(el);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      ro?.disconnect();
    };
  }, [workItemId, ready]);
  return ref;
}

function Question({ w, workItemId }: { w: WaitResponse; workItemId: string }) {
  const { t } = useI18n();
  const ref = useQuestionResize(workItemId, !!w.question);
  if (!w.question)
    return w.unavailable && w.unavailable !== "off" ? (
      <p className="text-fg3 text-meta">{t("answer.unreadable")}</p>
    ) : w.error ? (
      <p className="text-body text-fg">{t(`ai.err.${w.error}`)}</p>
    ) : null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-fg3">{t("turn.why.question")}</span>
      <div
        ref={ref}
        style={{ maxHeight: QUESTION_MAX }}
        className="resize-y overflow-auto break-words rounded-[8px] bg-sunken px-3 py-2 text-body text-fg"
        data-testid="answer-question"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 長い問いをキーでスクロールする
        tabIndex={0}
      >
        {/* AI の文の Markdown（HTML は解釈しない。Issue #8） */}
        <Markdown text={w.question.text} />
      </div>
      {w.question.truncated ? (
        <span className="text-[11px] text-fg3">{t("answer.truncated")}</span>
      ) : null}
      {w.question.masked ? (
        <span className="text-[11px] text-fg3">{t("turn.why.redacted")}</span>
      ) : null}
    </div>
  );
}

function CantSend({ w, onOpen }: { w: WaitResponse; onOpen: () => void }) {
  const { t } = useI18n();
  const reason = w.delivery.reason ?? "unsupported";
  return (
    <div className="flex flex-col gap-2" data-testid="answer-cant" data-reason={reason}>
      {/* 報告の項目は「送れない」ではなく、答える場所を言う */}
      {reason === "report" ? null : <p className="text-body text-fg">{t("answer.cantSend")}</p>}
      <p className="text-fg2 text-meta">
        {t(`answer.cantSend.${reason}`, { app: w.delivery.terminal ?? t("answer.cantSend") })}
      </p>
      <div>
        <Button variant="primary" className="px-2" onClick={onOpen} data-testid="answer-open">
          {t("answer.open")}
        </Button>
      </div>
    </div>
  );
}

function PermissionAnswer({
  w,
  busy,
  onAllow,
  onOpen,
}: {
  w: WaitResponse;
  busy: boolean;
  onAllow: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  if (!w.canAllow) return <CantSend w={w} onOpen={onOpen} />;
  return (
    <div className="flex flex-col gap-2" data-testid="answer-permission">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          className="px-2"
          disabled={busy}
          onClick={onAllow}
          data-testid="answer-allow"
        >
          {busy ? t("answer.sending") : t("answer.allow")}
        </Button>
        <Button className="px-2" onClick={onOpen} data-testid="answer-open">
          {t("answer.openToDecide")}
        </Button>
      </div>
      <p className="text-[11px] text-fg3">
        {t("answer.allowHint", { where: w.delivery.landing ?? "" })}
      </p>
    </div>
  );
}
