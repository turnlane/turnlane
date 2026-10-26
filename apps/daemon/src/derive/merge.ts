/**
 * カードの統合（m2-api.md 19章）。ユーザーの統合（POST /api/work-items/:id/merge）と、runner の付け替え
 * （PR のカードのリポジトリを PR の属するリポジトリに直したら、同じ repo×branch のカードが既にあった）が使う。
 * 統合元に merged_into_id と deleted_at を入れ（runner は以後そのキーのターン・PR を統合先に付ける）、フォローアップ
 * （閉じたものも）と待ち区間の履歴を付け替える。題名・非表示・手動完了は統合先のものを残す
 */
import type { Database } from "bun:sqlite";
import { derive, type MutateCtx, schema, updateRow } from "@turnlane/core";
import type { FollowUpRow } from "./load.ts";

export function mergeCardInto(
  sqlite: Database,
  mutate: MutateCtx,
  id: string,
  intoId: string,
  now: number,
): void {
  updateRow(mutate, schema.workItem, id, { mergedIntoId: intoId, deletedAt: now });
  // 重複の鍵（work_item|kind|ref）も統合先のものにする（runner が同じ自分の番を作り直さないように）。
  // 統合先に同じ鍵が既にあれば、統合元のものは superseded で閉じる
  const keyUsed = sqlite.query<{ id: string }, [string]>(
    "SELECT id FROM follow_up WHERE dedupe_key = ?",
  );
  for (const f of sqlite
    .query<
      { id: string; kind: FollowUpRow["kind"]; artifact_ref: string; status: string },
      [string]
    >(
      "SELECT id, kind, artifact_ref, status FROM follow_up WHERE work_item_id = ? AND deleted_at IS NULL",
    )
    .all(id)) {
    const key = derive.dedupeKey(intoId, f.kind, f.artifact_ref);
    if (keyUsed.get(key)) {
      const live = f.status === "open" || f.status === "snoozed";
      updateRow(mutate, schema.followUp, f.id, {
        workItemId: intoId,
        ...(live
          ? { status: "superseded" as const, closedAt: now, closeReason: "superseded" }
          : {}),
      });
    } else updateRow(mutate, schema.followUp, f.id, { workItemId: intoId, dedupeKey: key });
  }
  // 取り込み系（同期しない）の行は直接付け替える（runner も次の判定で同じ付け方をする）
  sqlite.run("UPDATE ai_wait_segment SET work_item_id = ? WHERE work_item_id = ?", [intoId, id]);
  sqlite.run("UPDATE ai_turn SET work_item_id = ? WHERE work_item_id = ?", [intoId, id]);
  sqlite.run("UPDATE ai_artifact SET work_item_id = ? WHERE work_item_id = ?", [intoId, id]);
}
