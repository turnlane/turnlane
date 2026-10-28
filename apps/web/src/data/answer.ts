/**
 * Turnlane から答える（D-238、ADR 0019）: 待ちの中身と届け先（GET /api/work-items/:id/wait）と、答えを送る
 * （POST /api/work-items/:id/answer）。
 * - 待ちの中身（問いの全文）は「答える」の節を開いている間だけ取りに行き、閉じたら捨てる（キャッシュに残さない。gcTime 0）
 * - 答えの文は画面に残さない（送ったら入力欄を空にする。記録から取り込まれた指示として次の判定で出る）
 */
import { useQuery } from "@tanstack/react-query";
import type { AnswerInput, AnswerResult, OpenWaitBrief, WaitResponse } from "@turnlane/core/web";
import { answerSentText } from "@turnlane/core/web";
import { useSyncExternalStore } from "react";
import { getLocale } from "../i18n/current.ts";
import { translate } from "../i18n/index.tsx";
import { ApiError, api, unwrap } from "../lib/api.ts";
import { nowMs } from "../lib/clock.ts";
import { toast } from "../lib/store.ts";
import { queryClient } from "./client.ts";
import { glanceKey } from "./glance.ts";
import { rememberLanding } from "./landing.ts";
import { openTask } from "./mutations.ts";

export const waitKey = (workItemId: string) => ["wait", workItemId] as const;

/**
 * 「答える」を出すか（問い・許可・エラーの待ち。PR の確認・マージは出さない）。デーモンが queue の item と詳細に付ける
 * 待ち（`wait` / `openWait`。core の derive.openWaitOf。D-240）があるときだけ。猶予の間の問いのように自分の番の行が
 * まだ無い待ちにも付く
 */
export function answerable(x: { wait?: OpenWaitBrief } | null | undefined): boolean {
  return !!x?.wait;
}

/** 設定「Turnlane から答える」（turn.answer。既定オン） */
export function useAnswerEnabled(): boolean {
  const q = useQuery({
    queryKey: ["settings", "config"],
    queryFn: () =>
      unwrap<{ values: Record<string, unknown> }>(api.api.config.$get()).then((r) => r.values),
    staleTime: 60_000,
  });
  return q.data?.["turn.answer"] !== false;
}

/** 待ちの中身と届け先（開いている間だけ。閉じたら捨てる） */
export function useWait(workItemId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...waitKey(workItemId ?? ""), "open"],
    queryFn: () =>
      unwrap<WaitResponse>(
        api.api["work-items"][":id"].wait.$get({ param: { id: workItemId ?? "" } }),
      ),
    enabled: enabled && !!workItemId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * 送った印（D-241）: 送った後、その待ちが閉じるまで節に「10:25 に送りました · 確認済み」を残す。web の状態だけで持つ
 * （DB に保存しない。再読み込みで消える）。キーは待ち（カード・ターン・種類）
 */
export interface SentMark {
  at: number;
  confirmed: boolean;
}
const sentMarks = new Map<string, SentMark>();
const sentListeners = new Set<() => void>();
export const sentKey = (workItemId: string, w: { turnId: string | null; kind: string } | null) =>
  `${workItemId}|${w?.turnId ?? ""}|${w?.kind ?? ""}`;
export function markSent(key: string, m: SentMark): void {
  sentMarks.set(key, m);
  for (const f of sentListeners) f();
}
export function useSentMark(key: string): SentMark | null {
  return useSyncExternalStore(
    (f) => {
      sentListeners.add(f);
      return () => sentListeners.delete(f);
    },
    () => sentMarks.get(key) ?? null,
    // 静的な描画（試験）では送った印は無い
    () => null,
  );
}

export type AnswerOutcome =
  | { ok: true; result: AnswerResult }
  | { ok: false; code: "wait_closed" | "undeliverable" | "failed" };

const isQueue = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === "queue";

/**
 * 答えを送る。送った後は知らせ（`送りました · Orca · タブ`。確かめられなければ「進んだか確認できません」）を出し、
 * 行に着地を残す（D-217 と同じ部品）。409 wait_closed は「もう進んでいます」と出して行を読み直す。
 * 確かめられたときはデーモンがタブを前に出さない（D-241）ので、知らせに「開く」を付ける（「開く」と同じ経路。
 * フォローアップの無い待ちはカードで開く）。markKey があれば送った印を残す
 */
export async function sendAnswer(
  workItemId: string,
  followUpId: string | null,
  input: AnswerInput,
  markKey?: string,
): Promise<AnswerOutcome> {
  const loc = getLocale();
  try {
    const r = await unwrap<AnswerResult>(
      api.api["work-items"][":id"].answer.$post({ param: { id: workItemId }, json: input }),
    );
    if (followUpId && r.focus)
      rememberLanding(followUpId, { app: r.app, landing: r.focus, at: Date.now() });
    if (r.confirmed)
      toast(answerSentText(r, loc), {
        label: translate(loc, "answer.open"),
        run: () => void openTask(followUpId ? { followUpId } : { workItemId }),
      });
    else toast(answerSentText(r, loc));
    if (markKey) markSent(markKey, { at: nowMs(), confirmed: r.confirmed });
    return { ok: true, result: r };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "";
    if (code === "wait_closed") {
      toast(translate(loc, "answer.closed"));
      return { ok: false, code: "wait_closed" };
    }
    toast(translate(loc, code === "undeliverable" ? "answer.undeliverable" : "answer.failed"));
    return { ok: false, code: code === "undeliverable" ? "undeliverable" : "failed" };
  } finally {
    void queryClient.invalidateQueries({ predicate: isQueue });
    void queryClient.invalidateQueries({ queryKey: glanceKey(workItemId) });
    queryClient.removeQueries({ queryKey: waitKey(workItemId) });
  }
}
