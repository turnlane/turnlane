/**
 * 保存した件名の掃除（ai-session-ingestion 4.4）: 相づちだけ・貼り付けの印だけの自分の指示は保存せず、保存済みの古い行も
 * 表示に使わずに項目の今の題名に落とす。起動時の 1 度の掃除（cleanStoredSubjects）は冪等。本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { insertRow, schema } from "@turnlane/core";
import { cleanStoredSubjects, storedSubject } from "../src/derive/stored-subject.ts";
import { closedRowsBetween } from "../src/derive/views.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const DAY = "2026-10-02";
const PASTED = '<pasted_content id="1">貼り付けた本文の 1 行目\n2 行目</pasted_content>';

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

/** 相づち＋貼り付けだけの指示で始め、問いで止まって 30 分後に返した作業 */
async function setup() {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/web-app", "/w/web-app");
  const root = join(env.home, ".claude");
  const tr = claudeTranscript(root, {
    sid: "99999999-0000-4000-8000-0000000000a1",
    cwd: "/w/web-app",
    branch: "fix/tax",
  });
  tr.aiTitle(T0, "Tax rounding");
  tr.human(T0, { text: `OK\n${PASTED}` });
  tr.assistantEnd(T0 + 5 * MIN, "どちらの丸め方にしますか？");
  env.clock.set(T0 + 25 * MIN);
  await env.sync();
  tr.human(T0 + 35 * MIN, { text: "四捨五入で" });
  tr.assistantEnd(T0 + 36 * MIN, "直しました。");
  env.clock.set(T0 + 40 * MIN);
  await env.sync();
  const id =
    env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item WHERE branch = 'fix/tax'").get()
      ?.id ?? "none";
  const instructions = () =>
    env.sqlite
      .query<{ text: string }, []>("SELECT text FROM ai_instruction ORDER BY at")
      .all()
      .map((r) => r.text);
  return { id, instructions, path: tr.path };
}

test("相づち＋貼り付けだけの指示は保存しない。件名は次の意味のある指示か項目の題名", async () => {
  const { id, instructions } = await setup();
  const saved = instructions();
  expect(saved).toEqual(["四捨五入で"]);
  expect(JSON.stringify(saved)).not.toContain("貼り付けた本文");
  // 件名は保存した次の指示（その日の最初の意味のある指示）
  expect(env.ai.deps.glance(id)?.prompt?.text).toBe("四捨五入で");
  // 閉じた返答の行の件名の既定は項目の今の題名
  const rows = closedRowsBetween(env.sqlite, T0 - 60 * MIN, T0 + 60 * MIN);
  expect(rows.length).toBe(1);
  // 人が応えて閉じた行は応答時間を持つ（デイビューの「今日閉じたもの」の返事までの中央値）
  expect(typeof rows[0]?.responseMs).toBe("number");
  const title = rows[0]?.title;
  expect(title?.t === "auto" ? title.params.title : null).toBe("Tax rounding");
});

test("保存済みの相づち・貼り付けの印の指示は表示に使わず、項目の題名に落ちる", async () => {
  const { id, path } = await setup();
  // 記録は消えた（Claude Code は 30 日で消す）。古い版のパーサが保存した行（相づち・貼り付けの印）に戻す
  rmSync(path);
  env.sqlite.run("UPDATE ai_instruction SET text = 'OK'");
  const turn = env.sqlite
    .query<{ id: string; session_id: string }, []>(
      "SELECT id, session_id FROM ai_turn ORDER BY started_at LIMIT 1",
    )
    .get();
  if (!turn) throw new Error("no turn");
  env.sqlite.run(
    "INSERT OR REPLACE INTO ai_instruction (turn_id, session_id, at, text, masked) VALUES (?, ?, ?, ?, 0)",
    [turn.id, turn.session_id, T0, '<pasted_content id="1">'],
  );
  expect(storedSubject(env.sqlite, id, DAY)).toBeNull();
  // glance は件名を返さない（画面は行の既定の件名 = 項目の今の題名）。離れていた間のまとめも同じ storedSubject
  expect(env.ai.deps.glance(id)?.prompt?.text ?? null).toBeNull();
  // 自動のタスクの作成時の件名が相づちでも、項目の今の題名で上書きされる
  const t = env.sqlite
    .query<{ title_params: string }, []>(
      "SELECT t.title_params FROM task t JOIN follow_up f ON f.task_id = t.id LIMIT 1",
    )
    .get();
  if (!t) throw new Error("no reply task");
  env.sqlite.run("UPDATE task SET title_params = ? WHERE title_key IS NOT NULL", [
    JSON.stringify({ ...JSON.parse(t.title_params), title: "OK" }),
  ]);
  const rows = closedRowsBetween(env.sqlite, T0 - 60 * MIN, T0 + 60 * MIN);
  const title = rows[0]?.title;
  expect(title?.t === "auto" ? title.params.title : null).toBe("Tax rounding");
});

test("起動時の掃除は保存した指示と自動のタスクの件名を直し、2 回目は何もしない（冪等）", async () => {
  const { instructions } = await setup();
  const turns = env.sqlite
    .query<{ id: string; session_id: string }, []>(
      "SELECT id, session_id FROM ai_turn ORDER BY started_at",
    )
    .all();
  const put = (i: number, text: string) =>
    env.sqlite.run(
      "INSERT OR REPLACE INTO ai_instruction (turn_id, session_id, at, text, masked) VALUES (?, ?, ?, ?, 0)",
      [turns[i]?.id ?? "", turns[i]?.session_id ?? "", T0 + i, text],
    );
  put(0, "OK");
  put(1, `丸め方を直して ${PASTED}`);
  const junk = insertRow(env.mutate, schema.task, {
    title: "",
    titleKey: "reply",
    titleParams: JSON.stringify({ title: "了解", repo: "web-app", branch: "fix/old" }),
    status: "todo",
    scheduledDate: DAY,
    laneOrder: "a0",
    source: "ai",
  });
  const keep = insertRow(env.mutate, schema.task, {
    title: "",
    titleKey: "reply",
    titleParams: JSON.stringify({ title: "Tax rounding", repo: "web-app", branch: "fix/tax" }),
    status: "todo",
    scheduledDate: DAY,
    laneOrder: "a1",
    source: "ai",
  });
  const updatedAt = (tid: string) =>
    env.sqlite
      .query<{ updated_at: number; title_params: string }, [string]>(
        "SELECT updated_at, title_params FROM task WHERE id = ?",
      )
      .get(tid);
  const keepBefore = updatedAt(keep.id);

  expect(cleanStoredSubjects(env.sqlite, env.mutate)).toEqual({ instructions: 2, tasks: 1 });
  expect(instructions()).toEqual(["丸め方を直して"]);
  expect(JSON.parse(updatedAt(junk.id)?.title_params ?? "{}").title).toBeNull();
  expect(updatedAt(keep.id)).toEqual(keepBefore);

  // 2 回目は何も変えない
  const snapshot = JSON.stringify(env.sqlite.query("SELECT * FROM ai_instruction").all());
  const changes = env.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM change_log").get();
  expect(cleanStoredSubjects(env.sqlite, env.mutate)).toEqual({ instructions: 0, tasks: 0 });
  expect(JSON.stringify(env.sqlite.query("SELECT * FROM ai_instruction").all())).toBe(snapshot);
  expect(env.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM change_log").get()).toEqual(
    changes,
  );
});

test("版の更新で読み直すと、空同然の題名だけのセッションの古い題名を消し、カードの題名を次の候補に直す", async () => {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/web-app", "/w/web-app");
  const root = join(env.home, ".claude");
  const tr = claudeTranscript(root, {
    sid: "99999999-0000-4000-8000-0000000000a2",
    cwd: "/w/web-app",
    branch: "fix/rounding-mode",
  });
  tr.aiTitle(T0, '<pasted_content id="1">');
  tr.human(T0, { text: "丸め方を直して" });
  tr.assistantEnd(T0 + 5 * MIN, "直しました。");
  env.clock.set(T0 + 10 * MIN);
  await env.sync();
  // 古い版のパーサが残した状態: セッションの題名とカードの題名が貼り付けの印のまま
  const junk = '<pasted_content id="1">';
  env.sqlite.run("UPDATE ai_session SET title = ?, title_source = 'ai_title'", [junk]);
  env.sqlite.run("UPDATE work_item SET title_auto = ?, title_source = 'ai_title'", [junk]);
  env.sqlite.run("UPDATE ingest_cursor SET parser_version = parser_version - 1");
  env.clock.set(T0 + 11 * MIN);
  await env.sync();
  const s = env.sqlite.query<{ title: string | null }, []>("SELECT title FROM ai_session").get();
  expect(s?.title).toBeNull();
  const w = env.sqlite
    .query<{ title_auto: string | null; title_source: string | null }, []>(
      "SELECT title_auto, title_source FROM work_item WHERE branch = 'fix/rounding-mode'",
    )
    .get();
  expect(w).toEqual({ title_auto: "rounding mode", title_source: "branch" });
  // もう一度回しても変わらない（冪等）
  env.clock.set(T0 + 12 * MIN);
  await env.sync();
  expect(
    env.sqlite
      .query<{ title_auto: string | null }, []>(
        "SELECT title_auto FROM work_item WHERE branch = 'fix/rounding-mode'",
      )
      .get()?.title_auto,
  ).toBe("rounding mode");
});
