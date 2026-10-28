/**
 * 最後の返答（GET /api/work-items/:id/last-reply。ADR 0019 の Decision 10）: AI の詳細パネルを開いている間だけ取りに行き、
 * 閉じたら捨てる（キャッシュに残さない。gcTime 0）。一覧（/api/queue）・SSE には入っていない。
 * version は項目の状態・最後の活動が変わったら読み直すための鍵（動作中は、その時点での最新の発言を出す）
 */
import { useQuery } from "@tanstack/react-query";
import type { InstructResult, LastReplyResponse } from "@turnlane/core/web";
import { answerSentText } from "@turnlane/core/web";
import { getLocale } from "../i18n/current.ts";
import { type MessageKey, translate } from "../i18n/index.tsx";
import { ApiError, api, unwrap } from "../lib/api.ts";
import { nowMs } from "../lib/clock.ts";
import { toast } from "../lib/store.ts";
import { markSent } from "./answer.ts";
import { queryClient } from "./client.ts";
import { openTask } from "./mutations.ts";

export const lastReplyKey = (workItemId: string) => ["last-reply", workItemId] as const;

export function useLastReply(workItemId: string, version: string, enabled = true) {
  return useQuery({
    queryKey: [...lastReplyKey(workItemId), version],
    queryFn: () =>
      unwrap<LastReplyResponse>(
        api.api["work-items"][":id"]["last-reply"].$get({ param: { id: workItemId } }),
      ),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
}

/** 次の指示の送った印のキー（項目の状態・最後の活動の間だけ。次の取り込みで消える） */
export const instructKey = (workItemId: string, version: string) =>
  `instruct|${workItemId}|${version}`;

/** 送れなかった理由（409 の error）→ 知らせの文 */
const REFUSED: Record<string, MessageKey> = {
  session_ended: "instruct.ended",
  process_unknown: "instruct.unknown",
  wait_open: "instruct.waitOpen",
  turn_in_progress: "instruct.running",
  unsupported: "answer.cantSend",
  not_found: "instruct.notFound",
};

/**
 * 次の指示を送る（Issue #9）。送った後は知らせ（`送りました · Orca · タブ`。確かめられたら「開く」を付ける）と送った印。
 * 送れなかったら理由を知らせ、最後の返答（と送れるかの判定）を読み直す。文は画面に残さない
 */
export async function sendInstruction(
  workItemId: string,
  text: string,
  markKey: string,
): Promise<{ ok: true; result: InstructResult } | { ok: false; code: string }> {
  const loc = getLocale();
  try {
    const r = await unwrap<InstructResult>(
      api.api["work-items"][":id"].instruct.$post({ param: { id: workItemId }, json: { text } }),
    );
    if (r.confirmed)
      toast(answerSentText(r, loc), {
        label: translate(loc, "answer.open"),
        run: () => void openTask({ workItemId, action: "session" }),
      });
    else toast(answerSentText(r, loc));
    markSent(markKey, { at: nowMs(), confirmed: r.confirmed });
    return { ok: true, result: r };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "";
    toast(translate(loc, REFUSED[code] ?? "answer.failed"));
    return { ok: false, code };
  } finally {
    void queryClient.invalidateQueries({ queryKey: lastReplyKey(workItemId) });
  }
}
