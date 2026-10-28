/**
 * 「次の指示」の入力欄（Issue #9、ADR 0019 の Decision 11）: AI の詳細パネルの「最後の返答」の下。待ちの無いセッションに、
 * 「答える」と同じ口で次の指示を届ける。送れるか（プロセスが動いている・ターンの終わり・待ちが無い・端末のタブ）は
 * デーモンが最後の返答の応答（`instruct`）で返す。送れないときは理由を短い 1 行で出す。
 *
 * - 入力欄 1 つ（複数行。⌘⏎ で送る）と「送る · <届け先>」。文は送ったら消す（画面に残さない）
 * - 送った後は、その項目の次の取り込み（状態・最後の活動が変わる）まで「12:34 に送りました · 確認済み」の 1 行（web の状態だけ）
 */
import type { InstructBlocked, InstructCheck } from "@turnlane/core/web";
import { fmtClock } from "@turnlane/core/web";
import { useState } from "react";
import { useSentMark } from "../data/answer.ts";
import { instructKey, sendInstruction } from "../data/last-reply.ts";
import { openTask } from "../data/mutations.ts";
import { useQueue } from "../data/queries.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { isImeKey } from "../lib/ime.ts";
import { openAnswer } from "./AnswerSection.tsx";
import { Button } from "./ui.tsx";

/** 送れない理由 → 1 行の文 */
const BLOCKED: Record<Exclude<InstructBlocked, "off">, MessageKey> = {
  session_ended: "instruct.ended",
  process_unknown: "instruct.unknown",
  wait_open: "instruct.waitOpen",
  turn_in_progress: "instruct.running",
  unreadable: "ai.lastReply.unreadable",
  unsupported: "answer.cantSend",
  not_found: "instruct.notFound",
};

export function NextInstruction({
  workItemId,
  version,
  check,
}: {
  workItemId: string;
  /** 項目の状態と最後の活動（送った印をこの値の間だけ出す） */
  version: string;
  check: InstructCheck;
}) {
  const { t } = useI18n();
  const tz = useQueue().data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const markKey = instructKey(workItemId, version);
  const sent = useSentMark(markKey);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!check.ok && check.reason === "off") return null;
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    const r = await sendInstruction(workItemId, text, markKey);
    setBusy(false);
    if (r.ok) setText("");
  };
  return (
    <div className="flex flex-col gap-2" data-testid="ai-instruct">
      <span className="text-[11px] text-fg3">{t("instruct.title")}</span>
      {sent ? (
        <p className="text-fg2 text-meta" data-testid="ai-instruct-sent">
          {t(sent.confirmed ? "answer.sentConfirmed" : "answer.sentUnconfirmed", {
            time: fmtClock(sent.at, tz),
          })}
        </p>
      ) : null}
      {check.ok ? (
        <>
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isImeKey(e)) return;
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label={t("instruct.placeholder")}
            placeholder={t("instruct.placeholder")}
            maxLength={4000}
            className="min-h-[52px] w-full min-w-0 resize-y rounded-control border border-line bg-bg px-2.5 py-1.5 text-body text-fg placeholder:text-fg3 focus:border-fg3"
            style={{ outline: "none" }}
            data-testid="ai-instruct-input"
          />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px] text-fg3">
              {t(check.multiline ? "answer.hint" : "answer.hintFolded")}
            </span>
            <Button
              variant="primary"
              className="max-w-[70%] px-2"
              disabled={busy || !text.trim()}
              onClick={() => void send()}
              data-testid="ai-instruct-send"
            >
              <span className="min-w-0 truncate">
                {busy ? t("answer.sending") : t("answer.sendTo", { where: check.landing })}
              </span>
              <span className="font-mono text-micro opacity-70">⌘⏎</span>
            </Button>
          </div>
        </>
      ) : sent ? null : (
        <div className="flex flex-wrap items-center gap-2" data-testid="ai-instruct-blocked">
          <p className="min-w-0 flex-1 text-fg2 text-meta" data-reason={check.reason}>
            {t(BLOCKED[check.reason as Exclude<InstructBlocked, "off">])}
          </p>
          {check.reason === "session_ended" || check.reason === "process_unknown" ? (
            <Button
              className="shrink-0 px-2"
              onClick={() => void openTask({ workItemId, action: "session" })}
              data-testid="ai-instruct-open"
            >
              {t("instruct.openTerminal")}
            </Button>
          ) : check.reason === "wait_open" ? (
            <Button
              className="shrink-0 px-2"
              onClick={() => openAnswer(workItemId)}
              data-testid="ai-instruct-answer"
            >
              {t("answer.action")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
