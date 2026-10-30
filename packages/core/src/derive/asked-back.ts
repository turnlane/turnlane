/**
 * 問い返しと、手で自分の番に戻した行（Issue #3。ADR 0020）。純粋関数にしてテストする。
 *
 * 問い返し: AI の問い A（返答タスク）に、利用者が問いで返した（その入力の 1 行目が問いの形。保存した 1 行目を
 * collectors の asksBack で判定し、TurnFact.instructionAsks に入れる）。そのときは A を「返答済み」で閉じない。
 * - 問いで返した入力のターン（AI がそれに答えている間）: 問い返し中（pending）。自分の番には出さない（読み取りの時刻で
 *   status を asked_back にする。DB は open のまま）
 * - AI の答えが問いでなく終わった（中断・エラー・Stop の hook で終わったものを含む）: A を元の件名のまま自分の番に戻す
 *   （returned。DB は open のまま）
 * - AI の答えが新しい問いで終わった: その問いが A を置き換える（replaced。A は superseded で閉じる）
 * - 問いでない入力が来た: 今までどおり返答済み（auto:human_input）
 *
 * 手で戻した行（returnedAt）: 閉じた行を利用者が自分の番に戻した。手で閉じるか、戻した後にそのカードで新しいターン（新しい
 * 記録）が始まるまで、自動では閉じない（返答済み・解決の兆候・期限切れ・状態を外れた、のどれでも閉じない）
 */
import { isAskReply } from "./status.ts";
import { type FollowUpFact, isHumanTurn, type TurnFact, type WorkItemFacts } from "./types.ts";

export type AskedBack = "pending" | "returned" | "replaced";

/** 問いを出したターンの後の人の入力のターン（同じセッション、始まりの順）から、問い返しの段階。問い返しでなければ null */
export function askedBackOf(
  humanTurnsAfter: readonly Pick<
    TurnFact,
    "status" | "endedWith" | "closingQuestion" | "instructionAsks"
  >[],
): AskedBack | null {
  if (humanTurnsAfter.length === 0) return null;
  if (!humanTurnsAfter.every((t) => t.instructionAsks === true)) return null;
  const last = humanTurnsAfter.at(-1) as (typeof humanTurnsAfter)[number];
  if (last.status === "running") return "pending";
  if (last.status === "completed" && last.endedWith === "question" && !last.closingQuestion)
    return "replaced";
  return "returned";
}

/** 返答タスクの問い返しの段階（AskUserQuestion の返答タスクは対象外。選択肢を選ぶ画面に問いで返すことはできない） */
export function askedBackOfFollowUp(
  f: Pick<WorkItemFacts, "turns" | "sessionTurns">,
  fu: Pick<FollowUpFact, "kind" | "artifactRef" | "triggerTurnId">,
): AskedBack | null {
  if (fu.kind !== "reply" || isAskReply(fu)) return null;
  const trigger = f.turns.find((t) => t.id === fu.triggerTurnId);
  if (!trigger) return null;
  const after = (f.sessionTurns.get(trigger.sessionId) ?? []).filter(
    (t) => t.startedAt > trigger.startedAt && isHumanTurn(t),
  );
  return askedBackOf(after);
}

/**
 * 返答済みに数える人の入力（問いで返した入力を飛ばした、最初の問いでない入力の始まり）。無ければ null
 */
export function answeringInputAfter(
  f: Pick<WorkItemFacts, "sessionTurns">,
  sessionId: string,
  after: number,
): number | null {
  for (const t of f.sessionTurns.get(sessionId) ?? []) {
    if (t.startedAt > after && isHumanTurn(t) && t.instructionAsks !== true) return t.startedAt;
  }
  return null;
}

/** 手で戻した行を閉じる新しい記録: 戻した時刻より後に始まった、そのカードの最初のターン。無ければ null */
export function turnAfterReturn(
  f: Pick<WorkItemFacts, "turns">,
  fu: Pick<FollowUpFact, "returnedAt">,
): TurnFact | null {
  const at = fu.returnedAt;
  if (at === null || at === undefined) return null;
  return f.turns.find((t) => t.startedAt > at) ?? null;
}
