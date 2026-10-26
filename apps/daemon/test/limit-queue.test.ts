/**
 * 上限待ちの「後で」（GET /api/queue の limitWaits = views の limitQueue）と、明ける時刻が伸びた再開のタスク:
 * - 再開のタスク（`<turn>:limit`）を利用者が閉じた（dismissed）ときだけ「後で」から外す。自動で閉じた行は外す理由にしない
 * - 旧版が 5 時間の見込みで作り、明ける時刻が週の明けに伸びて自動で閉じた行（auto:next_turn_ok）でも、入れ直し後の
 *   最初の判定で「後で」に出て、明けたら同じ行で「再開できる」が 1 回だけ出る（通知も 1 回）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "@turnlane/core";
import { initialNotifyState, planNotifications } from "@turnlane/core/web";
import { limitQueue, queue } from "../src/derive/views.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 22, 9, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  const sync = env.sync.bind(env);
  env.sync = async () => {
    await env.ai.supervisor.beginIngest();
    await sync();
  };
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const root = join(env.home, ".claude");
  mkdirSync(join(root, "projects"), { recursive: true });
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const lines: string[] = [];
  const hook = (sid: string, name: string, at: number, extra: Record<string, unknown> = {}) => {
    lines.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: sid,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261022.jsonl"), `${lines.join("\n")}\n`);
  };
  let mtime = 1000;
  const cache = (fetchedAtMs: number, weekly: number) => {
    const file = join(root, ".claude.json");
    writeFileSync(
      file,
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs,
          utilization: {
            five_hour: { utilization: 10, resets_at: new Date(fetchedAtMs + H).toISOString() },
            seven_day: { utilization: 100, resets_at: new Date(weekly).toISOString() },
          },
        },
      }),
    );
    mtime += 1000;
    utimesSync(file, mtime, mtime);
  };
  const sid = "77777777-0000-4000-8000-000000000001";
  // 週の上限で止まったセッション（旧版の記録: 定型文の真偽も無い。明ける時刻は 5 時間の見込み）
  const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "fix/weekly" });
  tr.human(T0);
  hook(sid, "UserPromptSubmit", T0);
  hook(sid, "StopFailure", T0 + 20 * MIN);
  hook(sid, "Notification", T0 + 21 * MIN, { notification_type: "quota_auto_resume_disabled" });
  const itemId = () =>
    env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE branch = ?")
      .get("fix/weekly")?.id as string;
  const limitRows = () =>
    env.sqlite
      .query<
        { id: string; status: string; close_reason: string | null; trigger_at: number },
        [string]
      >(
        "SELECT id, status, close_reason, trigger_at FROM follow_up WHERE work_item_id = ? AND dedupe_key LIKE '%:limit'",
      )
      .all(itemId());
  const settings = () => readSettings(env.mutate.db, "Asia/Tokyo");
  const later = () => limitQueue(env.sqlite, settings(), env.clock.now());
  const items = () => queue(env.sqlite, settings(), env.clock.now());
  return { cache, itemId, limitRows, later, items };
}

describe("上限待ちの「後で」と、明ける時刻が伸びた再開のタスク", () => {
  test("旧版の記録（5 時間で作られ自動で閉じた `:limit`）＋ .claude.json の週の明け: 後でに出て、明けたら同じ行で 1 回だけ再開できる", async () => {
    const { cache, limitRows, later, items } = setup();
    const stopAt = T0 + 20 * MIN;
    // 旧版: 5 時間の見込みで明け、再開のタスクができた
    env.clock.set(stopAt + 5 * H + MIN);
    await env.sync();
    const [first] = limitRows();
    expect(first).toMatchObject({ status: "open", trigger_at: stopAt + 5 * H });
    // 旧版の再導出が自動で閉じた形（auto:next_turn_ok）にしておく
    env.sqlite.run(
      "UPDATE follow_up SET status = 'done', closed_at = ?, close_reason = 'auto:next_turn_ok' WHERE id = ?",
      [stopAt + 6 * H, first?.id ?? ""],
    );
    // 入れ直し: .claude.json に週の明け（2 日後）
    const weekly = T0 + 2 * D;
    env.clock.set(stopAt + 7 * H);
    cache(stopAt + 6 * H, weekly);
    await env.sync();
    // 後でに「利用上限 · 〜まで」で出る（明ける時刻が分かっている）
    expect(later().map((x) => x.limitWait)).toEqual([
      { since: stopAt, until: weekly, untilKnown: true },
    ]);
    expect(items().filter((x) => x.followUps.some((f) => f.status === "open"))).toEqual([]);
    // 通知: 明ける前の状態を見たことにしてから
    let st = planNotifications(initialNotifyState(), items(), env.clock.now()).state;
    // 明けた: 同じ行が開く（作り直さない）
    env.clock.set(weekly + MIN);
    await env.sync();
    const rows = limitRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first?.id,
      status: "open",
      close_reason: null,
      trigger_at: weekly,
    });
    expect(later()).toEqual([]);
    const p1 = planNotifications(st, items(), env.clock.now());
    expect(p1.notices).toHaveLength(1);
    st = p1.state;
    // もう一度判定しても増えない
    env.clock.set(weekly + 10 * MIN);
    await env.sync();
    expect(limitRows()).toHaveLength(1);
    expect(planNotifications(st, items(), env.clock.now()).notices).toHaveLength(0);
  });

  test("開いていた `:limit` は、明ける時刻が伸びたら閉じずに「まだ明けていない」（auto:limit_extended）になり、後でに出る", async () => {
    const { cache, limitRows, later } = setup();
    const stopAt = T0 + 20 * MIN;
    env.clock.set(stopAt + 5 * H + MIN);
    await env.sync();
    const weekly = T0 + 2 * D;
    env.clock.set(stopAt + 5 * H + 2 * MIN);
    cache(stopAt + 5 * H + MIN, weekly);
    await env.sync();
    expect(limitRows()).toMatchObject([
      { status: "superseded", close_reason: "auto:limit_extended", trigger_at: stopAt + 5 * H },
    ]);
    expect(later()).toHaveLength(1);
    // 再開のタスクのタスクは完了と数えない（取り消し）
    const task = env.sqlite
      .query<{ status: string }, []>(
        "SELECT t.status FROM task t JOIN follow_up f ON f.task_id = t.id WHERE f.dedupe_key LIKE '%:limit'",
      )
      .get();
    expect(task?.status).toBe("canceled");
  });

  test("利用者が対応不要にした（dismiss-limit）ものは後でに出さない", async () => {
    const { cache, itemId, later } = setup();
    env.clock.set(T0 + 30 * MIN);
    cache(T0 + 25 * MIN, T0 + 2 * D);
    await env.sync();
    expect(later()).toHaveLength(1);
    env.ai.deps.ops.dismissLimit(itemId());
    env.ai.runner.runOnce();
    expect(later()).toEqual([]);
    // 明けても再開できるは出ない
    env.clock.set(T0 + 2 * D + MIN);
    await env.sync();
    expect(
      env.sqlite
        .query<{ status: string }, []>(
          "SELECT status FROM follow_up WHERE dedupe_key LIKE '%:limit'",
        )
        .all(),
    ).toEqual([{ status: "dismissed" }]);
  });
});
