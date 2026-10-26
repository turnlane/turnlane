/**
 * Claude の利用枠の 2 つ目の入り口（`.claude.json` の cachedUsageUtilization）と、週の上限で止まった上限待ち:
 * - 取り込みの live probe が `.claude.json` の更新を見つけると、5 時間・7 日の枠の使用率と明ける時刻だけを利用枠の記録先へ
 *   入れ、判定をやり直す（上限待ちの明ける時刻が週の明けになる）。ほかのキーは DB に入らない
 * - statusLine の受け口から届いた新しい値を、古いキャッシュで上書きしない
 * - quota_auto_resume_disabled の「明けるのが 24 時間より先」（hook の quota_horizon）で、時刻が分からない間の見込みは 24 時間
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardLimitWait } from "../src/derive/limit.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 22, 9, 0);
const S = "SENTINEL_BODY_claude_json_daemon";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  // live probe は取り込みを始めた後だけ動く（同意済みの扱い。テストの sync は始めない）
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
  const cache = (fetchedAtMs: number, sevenDayResetsAt: number, fiveHourResetsAt: number) => {
    const file = join(root, ".claude.json");
    writeFileSync(
      file,
      JSON.stringify({
        oauthAccount: { accountUuid: S, emailAddress: S },
        userID: S,
        projects: { "/w/app": { lastSessionId: S } },
        cachedUsageUtilization: {
          fetchedAtMs,
          accountUuid: S,
          utilization: {
            five_hour: { utilization: 38, resets_at: new Date(fiveHourResetsAt).toISOString() },
            seven_day: { utilization: 100, resets_at: new Date(sevenDayResetsAt).toISOString() },
            limits: [{ kind: "weekly_all", percent: 100, severity: S }],
          },
        },
      }),
    );
    mtime += 1000;
    utimesSync(file, mtime, mtime);
  };
  /** 週の上限で止まったセッション（T0 に始まり T0+20m に種類の無い StopFailure、T0+21m に自動再開を止めた通知） */
  const weeklyStop = (sid: string, branch: string, horizon: boolean) => {
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch });
    tr.human(T0);
    hook(sid, "UserPromptSubmit", T0);
    hook(sid, "StopFailure", T0 + 20 * MIN);
    hook(sid, "Notification", T0 + 21 * MIN, {
      notification_type: "quota_auto_resume_disabled",
      ...(horizon ? { quota_horizon: true } : {}),
    });
  };
  const itemOf = (branch: string) =>
    env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE branch = ?")
      .get(branch)?.id as string;
  const fus = (id: string) =>
    env.sqlite
      .query<{ kind: string; artifact_ref: string; status: string; trigger_at: number }, [string]>(
        "SELECT kind, artifact_ref, status, trigger_at FROM follow_up WHERE work_item_id = ?",
      )
      .all(id);
  return { root, hook, cache, weeklyStop, itemOf, fus };
}

describe("週の上限で止まった上限待ち", () => {
  test("定型文（24 時間より先）があれば見込みは 24 時間。`.claude.json` の更新で週の明けに直り、明けたら再開できるを 1 件", async () => {
    const { root, cache, weeklyStop, itemOf, fus } = setup();
    weeklyStop("66666666-0000-4000-8000-000000000001", "fix/weekly", true);
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const id = itemOf("fix/weekly");
    expect(cardLimitWait(env.sqlite, id, env.clock.now())).toMatchObject({
      since: T0 + 20 * MIN,
      until: T0 + 20 * MIN + D,
      untilKnown: false,
    });
    // 5 時間を過ぎても「再開できる」にしない
    env.clock.set(T0 + 6 * H);
    await env.sync();
    expect(fus(id)).toEqual([]);
    expect(cardLimitWait(env.sqlite, id, env.clock.now())?.until).toBe(T0 + 20 * MIN + D);

    // Claude Code が `.claude.json` に利用枠をキャッシュした: 7 日の枠を使い切り、T0+2d に明ける
    const weekly = T0 + 2 * D;
    cache(T0 + 6 * H - MIN, weekly, T0 + 7 * H);
    let scheduled = 0;
    const schedule = env.ai.runner.schedule.bind(env.ai.runner);
    env.ai.runner.schedule = (...a: Parameters<typeof schedule>) => {
      scheduled++;
      return schedule(...a);
    };
    await env.ai.supervisor.probeLive();
    // 記録したら判定をやり直す（runner を起こす）
    expect(scheduled).toBe(1);
    expect(env.limits.get(root)).toEqual({
      fiveHour: { usedPercentage: 38, resetsAt: T0 + 7 * H },
      sevenDay: { usedPercentage: 100, resetsAt: weekly },
      at: T0 + 6 * H - MIN,
    });
    // 同じ mtime のままなら読み直さない・起こさない
    await env.ai.supervisor.probeLive();
    expect(scheduled).toBe(1);
    env.ai.runner.runOnce();
    expect(cardLimitWait(env.sqlite, id, env.clock.now())).toMatchObject({
      until: weekly,
      untilKnown: true,
    });
    // 24 時間を過ぎても上限待ちのまま。週が明けたら再開できるを 1 件
    env.clock.set(T0 + D + H);
    await env.sync();
    expect(fus(id)).toEqual([]);
    env.clock.set(weekly + MIN);
    await env.sync();
    expect(fus(id)).toMatchObject([{ kind: "resume_error", status: "open", trigger_at: weekly }]);

    // `.claude.json` のほかのキーは DB（WAL を含む）に入らない
    env.sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const f of ["turnlane.db", "turnlane.db-wal"]) {
      const p = join(env.dataDir, f);
      if (existsSync(p)) expect(readFileSync(p).includes(S)).toBe(false);
    }
  });

  test("定型文が無ければ今までどおり 5 時間の見込み（時刻が取れればそちらが勝つ）", async () => {
    const { cache, weeklyStop, itemOf } = setup();
    weeklyStop("66666666-0000-4000-8000-000000000002", "fix/plain", false);
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const id = itemOf("fix/plain");
    expect(cardLimitWait(env.sqlite, id, env.clock.now())?.until).toBe(T0 + 20 * MIN + 5 * H);
    cache(T0 + 25 * MIN, T0 + 2 * D, T0 + 3 * H);
    await env.sync();
    expect(cardLimitWait(env.sqlite, id, env.clock.now())).toMatchObject({
      until: T0 + 2 * D,
      untilKnown: true,
    });
  });

  test("statusLine の受け口から届いた新しい値を、古いキャッシュで上書きしない", async () => {
    const { root, cache } = setup();
    await env.sync();
    env.clock.set(T0 + 30 * MIN);
    env.limits.record(root, { fiveHour: { usedPercentage: 12, resetsAt: T0 + 4 * H } });
    // 受けた時刻（T0+30m）より前に取得したキャッシュは記録しない
    cache(T0 + 10 * MIN, T0 + 2 * D, T0 + 3 * H);
    await env.ai.supervisor.probeLive();
    expect(env.limits.get(root)).toEqual({
      fiveHour: { usedPercentage: 12, resetsAt: T0 + 4 * H },
      at: T0 + 30 * MIN,
    });
    // 後に取得したものは記録する
    cache(T0 + 40 * MIN, T0 + 2 * D, T0 + 3 * H);
    await env.ai.supervisor.probeLive();
    expect(env.limits.get(root)?.at).toBe(T0 + 40 * MIN);
    expect(env.limits.get(root)?.sevenDay).toEqual({ usedPercentage: 100, resetsAt: T0 + 2 * D });
    // 再起動しても DB から読める（取得時刻ごと）
    const row = env.sqlite
      .query<{ account: string; at: number }, []>("SELECT account, at FROM claude_limit")
      .all();
    expect(row).toEqual([{ account: root, at: T0 + 40 * MIN }]);
  });
});
