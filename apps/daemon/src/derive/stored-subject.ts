/**
 * 保存した件名（ADR 0018 の自分の指示の 1 行目 `ai_instruction.text`、自動のタスクの作成時の件名 `task.title_params.title`）の掃除
 * （ai-session-ingestion 4.4）。相づちだけ・貼り付けの印だけの件名を表示に使わず、項目の今の題名（titleResolver の subject）に
 * 落とす。保存の時点（sink）と表示の時点（ここ）の両方で同じ cleanTitle を通す。保存済みの古い行は起動時に 1 度だけ直す
 * （cleanStoredSubjects。会話本文は読まない。冪等）
 */
import type { Database } from "bun:sqlite";
import { cleanSubjectLine, cleanTitle, PROMPT_SUBJECT_MAX } from "@turnlane/collectors";
import { type MutateCtx, parseTaskTitleParams, schema, updateRow } from "@turnlane/core";

/** 保存した自分の指示を件名に使える形に（空同然なら null。タグを除く。相づちで始まる文はそのまま） */
export function cleanSubject(text: string | null | undefined): string | null {
  return text ? cleanSubjectLine(text, PROMPT_SUBJECT_MAX) : null;
}

/**
 * 件名に使う保存した指示: その日の最初のもの（無ければ直近のもの）。ADR 0018。空同然の指示は飛ばす。
 * dayOnly ならその日のものだけ
 */
export function storedSubject(
  db: Database,
  workItemId: string,
  day: string,
  o: { dayOnly?: boolean } = {},
): string | null {
  const first = (where: string, order: string, args: string[]) => {
    for (const r of db
      .query<{ text: string }, string[]>(
        `SELECT i.text FROM ai_instruction i JOIN ai_turn t ON t.id = i.turn_id
         WHERE t.work_item_id = ? ${where} ORDER BY i.at ${order}`,
      )
      .all(...args)) {
      const c = cleanSubject(r.text);
      if (c !== null) return c;
    }
    return null;
  };
  return (
    first("AND t.local_date = ?", "ASC", [workItemId, day]) ??
    (o.dayOnly ? null : first("", "DESC", [workItemId]))
  );
}

/**
 * 起動時の 1 度の掃除: 保存した指示と自動のタスクの作成時の件名を cleanTitle の結果で直す。空同然の指示の行は消す
 * （ADR 0018 の保存は設定で消せる範囲。取り込みの行ではない）。自動のタスクの件名は空同然なら null（表示は項目の今の題名）。
 * 直したものが無ければ何も書かない（冪等）
 */
export function cleanStoredSubjects(
  sqlite: Database,
  mutate: MutateCtx,
): { instructions: number; tasks: number } {
  let instructions = 0;
  let tasks = 0;
  sqlite.transaction(() => {
    const rows = sqlite
      .query<{ turn_id: string; text: string }, []>("SELECT turn_id, text FROM ai_instruction")
      .all();
    for (const r of rows) {
      const c = cleanSubject(r.text);
      if (c === r.text) continue;
      if (c === null) sqlite.run("DELETE FROM ai_instruction WHERE turn_id = ?", [r.turn_id]);
      else sqlite.run("UPDATE ai_instruction SET text = ? WHERE turn_id = ?", [c, r.turn_id]);
      instructions++;
    }
  })();
  const auto = sqlite
    .query<{ id: string; title_params: string }, []>(
      "SELECT id, title_params FROM task WHERE title_key IS NOT NULL AND title_params IS NOT NULL AND deleted_at IS NULL",
    )
    .all();
  for (const t of auto) {
    const p = parseTaskTitleParams(t.title_params);
    if (p.title === null || p.title === undefined) continue;
    // 保存済みの題名は切らない（長さはそのまま。相づち・タグだけを直す）
    const c = cleanTitle(p.title, Number.POSITIVE_INFINITY);
    if (c === p.title) continue;
    updateRow(mutate, schema.task, t.id, { titleParams: JSON.stringify({ ...p, title: c }) });
    tasks++;
  }
  return { instructions, tasks };
}
