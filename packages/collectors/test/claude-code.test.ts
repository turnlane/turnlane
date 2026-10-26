import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCode, { CLAUDE_CODE } from "../src/adapters/claude-code/index.ts";
import { readTranscript } from "../src/adapters/claude-code/transcript.ts";
import type { NormalizedEvent, TurnEvent } from "../src/index.ts";
import {
  fixtureCtx,
  readAll,
  reduceEvents,
  rootFor,
  runGoldenSuite,
  runIncrementalSuite,
  runSentinelSuite,
  withRootJail,
} from "../src/testing/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures/claude_code");

runGoldenSuite(claudeCode, FIXTURES);
runIncrementalSuite(claudeCode, FIXTURES);
runSentinelSuite(claudeCode, FIXTURES);

async function eventsOf(caseName: string): Promise<NormalizedEvent[]> {
  const dir = join(FIXTURES, "2.1.x", caseName);
  return withRootJail([dir], () => readAll(claudeCode, rootFor(claudeCode, dir), fixtureCtx()));
}
const turns = (events: NormalizedEvent[]) =>
  Object.values(reduceEvents(events).turns) as Omit<TurnEvent, "kind">[];

describe("claude_code: パースの規則（ai-session-ingestion 1.1）", () => {
  test("合成ケース: 締めの決まり文句・API エラー・本当の質問・task-notification・pr-link の初出", async () => {
    const ev = await eventsOf("synthetic-closing-error");
    const t = turns(ev);
    expect(t.map((x) => [x.status, x.endedWith ?? null, x.initiator, x.closingQuestion])).toEqual([
      ["completed", "question", "human", true],
      ["error", "error", "queued", false],
      ["completed", "question", "human", false],
      ["running", null, "system", false],
    ]);
    expect(t[0]?.editedFiles).toBe(1);
    expect(t[0]?.durationMs).toBe(9500);
    expect(t[0]?.tokens).toEqual({ input: 22, output: 25, cacheRead: 210 });
    expect(t[3]?.pendingQuestion).toBe(true);
    // pr-link は2回出ているが artifact は1件
    expect(ev.filter((e) => e.kind === "artifact")).toHaveLength(1);
    const s = Object.values(reduceEvents(ev).sessions)[0];
    expect(s?.title).toBe("Fixture synthetic title");
    expect(s?.hasHumanInput).toBe(true);
    expect(s?.model).toBe("claude-opus-4-8");
  });

  test("サブエージェントは親子付けだけ（ターンを出さない）。ターン内でブランチが変わると終了時点の値", async () => {
    const ev = await eventsOf("subagent-branch-switch");
    const sessions = Object.values(reduceEvents(ev).sessions);
    const sub = sessions.find((s) => s.isSubagent);
    const main = sessions.find((s) => !s.isSubagent);
    expect(sub?.parent?.externalId).toBe(main?.ref.externalId);
    expect(ev.some((e) => e.kind === "turn" && e.ref.externalId === sub?.ref.externalId)).toBe(
      false,
    );
    const ts = turns(ev);
    expect(new Set(ts.map((x) => x.gitBranch)).size).toBeGreaterThan(1);
    expect(ts.some((x) => x.initiator === "system")).toBe(true);
    // 最後のレコードが最後の応答（end_turn）なので、サブエージェントは終わっている
    expect(sub?.endedAt).toBe(Date.parse("2026-09-01T09:03:04.409Z"));
  });

  test("書き込み途中の末尾行は読まない", async () => {
    const full = turns(await eventsOf("question-end"));
    const partial = turns(await eventsOf("partial-tail"));
    expect(partial.length).toBeLessThanOrEqual(full.length);
    expect(full.at(-1)?.endedWith).toBe("question");
  });

  test("privacy.storeTitles=false ならタイトルを出さない", async () => {
    const dir = join(FIXTURES, "2.1.x", "synthetic-closing-error");
    const ev = await readAll(
      claudeCode,
      rootFor(claudeCode, dir),
      fixtureCtx({ privacy: { storeTitles: false } }),
    );
    expect(JSON.stringify(ev)).not.toContain("Fixture synthetic title");
  });
});

describe("claude_code: 検出とライブ状態", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("~/.claude と ~/.claude-*（projects/ があるもの）と CLAUDE_CONFIG_DIR を検出する。どの名前のものも有効", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    for (const d of [
      ".claude/projects",
      ".claude-acme/projects",
      ".claude-empty",
      "other/projects",
    ]) {
      mkdirSync(join(home, d), { recursive: true });
    }
    const roots = await claudeCode.detect({
      home,
      vars: { CLAUDE_CONFIG_DIR: join(home, "other") },
    });
    expect(roots.map((r) => [r.rootPath.slice(home.length), r.profileLabel])).toEqual([
      ["/.claude", "default"],
      ["/.claude-acme", "acme"],
      ["/other", "default"],
    ]);
  });

  test("sessions/<pid>.json だけを読み、*.key は開かない。pid が死んでいれば gone", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    const root = join(home, ".claude");
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(
      join(root, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "s-alive",
        status: "busy",
        statusUpdatedAt: 5,
      }),
    );
    writeFileSync(
      join(root, "sessions", "999999.json"),
      JSON.stringify({ pid: 999999, sessionId: "s-dead", status: "idle", updatedAt: 6 }),
    );
    writeFileSync(join(root, "sessions", `${process.pid}.abc.key`), "SECRET");
    // 既定の ~/.claude はホーム直下の .claude.json も候補（無ければ読まない）
    const live = await withRootJail([root, join(home, ".claude.json")], async () => {
      // .key を開こうとしたらルート内でも失敗させる
      return (await claudeCode.probeLive?.(rootFor(claudeCode, root))) ?? [];
    });
    const status = live.flatMap((l) => (l.kind === "live_status" ? [l] : []));
    expect(status.map((l) => [l.ref.externalId, l.status, l.at]).sort()).toEqual([
      ["s-alive", "busy", 5],
      ["s-dead", "gone", 6],
    ]);
  });

  test(".claude.json の利用枠のキャッシュ: 5 時間・7 日の枠の使用率と明ける時刻だけを出し、ほかのキーは出さない。mtime が変わったときだけ読む", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    const root = join(home, ".claude");
    mkdirSync(join(root, "projects"), { recursive: true });
    const S = "SENTINEL_BODY_claude_json";
    const file = join(root, ".claude.json");
    const write = (fetchedAtMs: number, mtime: number, extra: object = {}) => {
      writeFileSync(
        file,
        JSON.stringify({
          numStartups: 3,
          oauthAccount: { accountUuid: S, emailAddress: S, organizationName: S },
          userID: S,
          projects: { [`/fixture/${S}`]: { history: [{ display: S }] } },
          cachedUsageUtilization: {
            fetchedAtMs,
            accountUuid: S,
            utilization: {
              five_hour: { utilization: 38, resets_at: "2026-10-23T06:10:00+00:00", note: S },
              seven_day: { utilization: 100, resets_at: "2026-10-23T17:59:59.647535+00:00" },
              seven_day_opus: { utilization: 5, resets_at: S },
              limits: [{ kind: "weekly_all", percent: 100, severity: S, is_active: true }],
              extra_usage: { is_enabled: false, label: S },
              ...extra,
            },
          },
        }),
      );
      utimesSync(file, mtime, mtime);
    };
    write(1792739655050, 1000);
    const r = rootFor(claudeCode, root);
    const probe = () =>
      withRootJail(
        [root, join(home, ".claude.json")],
        async () => (await claudeCode.probeLive?.(r)) ?? [],
      ).then((xs) => xs.filter((x) => x.kind === "claude_limits"));
    const first = await probe();
    expect(first).toEqual([
      {
        kind: "claude_limits",
        account: root,
        fetchedAt: 1792739655050,
        fiveHour: { pct: 38, resetsAt: Date.parse("2026-10-23T06:10:00Z") },
        sevenDay: { pct: 100, resetsAt: Date.parse("2026-10-23T17:59:59.647Z") },
      },
    ]);
    expect(JSON.stringify(first)).not.toContain(S);
    // mtime が同じなら読まない（中身が変わっていても）
    write(1792739999999, 1000);
    expect(await probe()).toEqual([]);
    // mtime が変わったら読み直す
    write(1792739999999, 2000);
    expect((await probe()).map((x) => (x.kind === "claude_limits" ? x.fetchedAt : 0))).toEqual([
      1792739999999,
    ]);
    // resets_at が null の枠は出さない。どの枠も無ければイベントを出さない
    writeFileSync(
      file,
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs: 5,
          utilization: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 12, resets_at: "2026-10-24T00:00:00Z" },
          },
        },
      }),
    );
    utimesSync(file, 3000, 3000);
    expect(await probe()).toEqual([
      {
        kind: "claude_limits",
        account: root,
        fetchedAt: 5,
        sevenDay: { pct: 12, resetsAt: Date.parse("2026-10-24T00:00:00Z") },
      },
    ]);
    writeFileSync(file, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 6 } }));
    utimesSync(file, 4000, 4000);
    expect(await probe()).toEqual([]);
    // 壊れた JSON・無いファイルは何も出さない
    writeFileSync(file, `{"cachedUsageUtilization": ${S}`);
    utimesSync(file, 5000, 5000);
    expect(await probe()).toEqual([]);
    rmSync(file);
    expect(await probe()).toEqual([]);
  });

  test("既定の ~/.claude は <root>/.claude.json が無ければホーム直下の ~/.claude.json を読む。CLAUDE_CONFIG_DIR 付きのルートは親を見ない", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    const S = "SENTINEL_BODY_home_claude_json";
    const dflt = join(home, ".claude");
    const other = join(home, ".claude-alt");
    for (const r of [dflt, other]) mkdirSync(join(r, "projects"), { recursive: true });
    const homeFile = join(home, ".claude.json");
    const body = (fetchedAtMs: number) =>
      JSON.stringify({
        oauthAccount: { emailAddress: S },
        cachedUsageUtilization: {
          fetchedAtMs,
          utilization: { seven_day: { utilization: 100, resets_at: "2026-10-24T00:00:00Z" } },
        },
      });
    writeFileSync(homeFile, body(7));
    utimesSync(homeFile, 1000, 1000);
    const probe = (root: string) =>
      withRootJail([root, homeFile], async () =>
        ((await claudeCode.probeLive?.(rootFor(claudeCode, root))) ?? []).filter(
          (x) => x.kind === "claude_limits",
        ),
      );
    const a = await probe(dflt);
    expect(a).toEqual([
      {
        kind: "claude_limits",
        account: dflt,
        fetchedAt: 7,
        sevenDay: { pct: 100, resetsAt: Date.parse("2026-10-24T00:00:00Z") },
      },
    ]);
    expect(JSON.stringify(a)).not.toContain(S);
    // mtime が同じなら読まない
    expect(await probe(dflt)).toEqual([]);
    // CLAUDE_CONFIG_DIR 付きのルートはホーム直下を見ない
    expect(await probe(other)).toEqual([]);
    // <root>/.claude.json があればそちらが先
    const own = join(dflt, ".claude.json");
    writeFileSync(own, body(9));
    utimesSync(own, 2000, 2000);
    expect((await probe(dflt)).map((x) => (x.kind === "claude_limits" ? x.fetchedAt : 0))).toEqual([
      9,
    ]);
  });

  test("許可リストに .claude.json の利用枠のキーだけを宣言している（ADR 0005）", () => {
    const keys = (claudeCode.allowlist as Record<string, readonly string[]>)[".claude.json"];
    expect(keys).toEqual([
      "cachedUsageUtilization.fetchedAtMs",
      "cachedUsageUtilization.utilization.five_hour.utilization",
      "cachedUsageUtilization.utilization.five_hour.resets_at",
      "cachedUsageUtilization.utilization.seven_day.utilization",
      "cachedUsageUtilization.utilization.seven_day.resets_at",
    ]);
  });

  test("サブエージェントの終わり: 最後の応答（end_turn）で endedAt、その後に活動があれば null（続きの読み込みでも同じ）", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    const root = join(home, ".claude");
    const sid = "00000000-0000-4000-8000-0000000000a1";
    const p = join(root, "projects", "-fixture-repo-a");
    mkdirSync(join(p, sid, "subagents"), { recursive: true });
    const file = join(p, sid, "subagents", "agent-a1.jsonl");
    const rec = (o: object) =>
      JSON.stringify({ sessionId: sid, isSidechain: true, cwd: "/fixture/repo-a", ...o });
    const asst = (at: string, stop: string | null) =>
      rec({
        type: "assistant",
        timestamp: at,
        message: { id: at, stop_reason: stop, content: [] },
      });
    const lines = [
      rec({
        type: "user",
        timestamp: "2026-10-01T01:00:00.000Z",
        message: { content: "(prompt)" },
      }),
      asst("2026-10-01T01:00:05.000Z", "tool_use"),
    ];
    writeFileSync(file, `${lines.join("\n")}\n`);
    const r0 = rootFor(claudeCode, root);
    const stream = (await claudeCode.listStreams(r0, {})).find((s) => s.key.includes("subagents"));
    if (!stream) throw new Error("no subagent stream");
    const seen = (ev: NormalizedEvent[]) => ev.find((e) => e.kind === "session_seen");
    const a = await claudeCode.read(stream, null, fixtureCtx({ home }));
    expect(seen(a.events)).toMatchObject({ endedAt: null, isSubagent: true });
    writeFileSync(file, `${[...lines, asst("2026-10-01T01:02:00.000Z", "end_turn")].join("\n")}\n`);
    const b = await claudeCode.read(stream, a.next, fixtureCtx({ home }));
    expect(seen(b.events)).toMatchObject({ endedAt: Date.parse("2026-10-01T01:02:00.000Z") });
    writeFileSync(
      file,
      `${[
        ...lines,
        asst("2026-10-01T01:02:00.000Z", "end_turn"),
        rec({ type: "user", timestamp: "2026-10-01T01:03:00.000Z", message: { content: [] } }),
      ].join("\n")}\n`,
    );
    const c = await claudeCode.read(stream, b.next, fixtureCtx({ home }));
    expect(seen(c.events)).toMatchObject({ endedAt: null });
  });

  test("ストリームは本体とサブエージェントだけ（tool-results・memory は対象外）", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    const root = join(home, ".claude");
    const p = join(root, "projects", "-x");
    mkdirSync(join(p, "s1", "subagents"), { recursive: true });
    mkdirSync(join(p, "s1", "tool-results"), { recursive: true });
    mkdirSync(join(p, "memory"), { recursive: true });
    for (const f of [
      "s1.jsonl",
      "s1/subagents/agent-a.jsonl",
      "s1/tool-results/x.txt",
      "memory/m.md",
    ]) {
      writeFileSync(join(p, f), "");
    }
    const streams = await claudeCode.listStreams(rootFor(claudeCode, root), {});
    expect(streams.map((s) => s.key).sort()).toEqual([
      "projects/-x/s1.jsonl",
      "projects/-x/s1/subagents/agent-a.jsonl",
    ]);
  });

  test("Codex の作業フォルダで動かしたセッション: キーと継続状態からフォルダ名を落とす（読むのは実際のパス。D-136）", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    const root = join(home, ".claude");
    const cwd = join(home, "Documents/Codex/2026-10-08/SENTINEL-plan-the-trip");
    const enc = cwd.replaceAll(/[^A-Za-z0-9]/g, "-");
    const dateEnc = join(home, "Documents/Codex/2026-10-08").replaceAll(/[^A-Za-z0-9]/g, "-");
    const sid = "00000000-0000-4000-8000-000000000136";
    const p = join(root, "projects", enc);
    mkdirSync(join(p, sid, "subagents"), { recursive: true });
    const rec = (o: object) => JSON.stringify({ sessionId: sid, isSidechain: false, cwd, ...o });
    writeFileSync(
      join(p, `${sid}.jsonl`),
      `${[
        rec({
          type: "user",
          uuid: "u1",
          promptId: "p1",
          timestamp: "2026-10-08T01:00:00.000Z",
          origin: { kind: "human" },
          message: { role: "user", content: "(prompt)" },
        }),
      ].join("\n")}\n`,
    );
    writeFileSync(
      join(p, sid, "subagents", "agent-a.jsonl"),
      `${rec({ type: "user", timestamp: "2026-10-08T01:00:01.000Z" })}\n`,
    );
    const r0 = rootFor(claudeCode, root);
    const streams = await claudeCode.listStreams(r0, {});
    expect(streams.map((s) => s.key).sort()).toEqual([
      `projects/${dateEnc}/${sid}.jsonl`,
      `projects/${dateEnc}/${sid}/subagents/agent-a.jsonl`,
    ]);
    // 監視から来たパスも同じキー
    expect(claudeCode.streamFor(r0, join(p, `${sid}.jsonl`))?.key).toBe(
      `projects/${dateEnc}/${sid}.jsonl`,
    );
    for (const s of streams) {
      expect(s.path).toContain("SENTINEL");
      const r = await claudeCode.read(s, null, fixtureCtx({ home }));
      expect(r.events.length).toBeGreaterThan(0);
      const out = JSON.stringify({ events: r.events, next: r.next, key: s.key });
      expect(out).not.toContain("SENTINEL");
    }
  });
});

describe("claude_code: 題名（ai-session-ingestion 4.4）", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const SID = "00000000-0000-4000-8000-0000000000e1";
  const S = "SENTINEL_BODY_title_case";
  const common = {
    sessionId: SID,
    isSidechain: false,
    cwd: "/fixture/repo-e",
    gitBranch: "feat/branch-e",
    version: "2.1.287",
    entrypoint: "cli",
  };
  const rec = (o: object) => JSON.stringify({ ...common, ...o });
  /** 人の指示・AI の応答（本文に番兵）と、題名の行（ai-title / summary）のトランスクリプト */
  function write(titleLines: object[]): string {
    dir = mkdtempSync(join(tmpdir(), "turnlane-title-"));
    const p = join(dir, "projects", "-fixture-repo-e");
    mkdirSync(p, { recursive: true });
    const lines = [
      rec({
        type: "user",
        timestamp: "2026-09-03T01:00:00.000Z",
        uuid: "e0000000-0000-4000-8000-000000000001",
        promptId: "e1000000-0000-4000-8000-000000000001",
        origin: { kind: "human" },
        promptSource: "typed",
        message: { role: "user", content: `${S} prompt body` },
      }),
      rec({
        type: "assistant",
        timestamp: "2026-09-03T01:00:05.000Z",
        uuid: "e0000000-0000-4000-8000-000000000002",
        message: {
          id: "msg_e1",
          model: "claude-opus-4-8",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: `${S} assistant body` }],
        },
      }),
      ...titleLines.map((o) => JSON.stringify(o)),
    ];
    writeFileSync(join(p, `${SID}.jsonl`), `${lines.join("\n")}\n`);
    return dir;
  }
  const read = (d: string, storeTitles = true) =>
    withRootJail([d], () =>
      readAll(claudeCode, rootFor(claudeCode, d), fixtureCtx({ privacy: { storeTitles } })),
    );
  const titleOf = (ev: NormalizedEvent[]) =>
    Object.values(reduceEvents(ev).sessions).find((s) => s.ref.externalId === SID)?.title;

  test("summary の行（最新のもの）を ai-title より優先する。会話本文はイベントに乗らない", async () => {
    const d = write([
      { type: "ai-title", sessionId: SID, aiTitle: "Fixture ai title" },
      {
        type: "summary",
        summary: "Older fixture summary",
        leafUuid: "e0000000-0000-4000-8000-0000000000f1",
      },
      { type: "summary", summary: "Newer fixture summary", leafUuid: S },
    ]);
    const ev = await read(d);
    expect(titleOf(ev)).toBe("Newer fixture summary");
    const out = JSON.stringify(ev);
    expect(out).not.toContain("SENTINEL");
    expect(out).not.toContain("Older fixture summary");
  });

  test("summary は 80 文字で切る。storeTitles=false なら summary も出さない", async () => {
    const long = `Fixture summary ${"x".repeat(100)}`;
    const d = write([
      { type: "summary", summary: long, leafUuid: "e0000000-0000-4000-8000-0000000000f1" },
    ]);
    const t = titleOf(await read(d));
    expect([...(t ?? "")].length).toBe(80);
    expect(t?.startsWith("Fixture summary x")).toBe(true);
    const off = JSON.stringify(await read(d, false));
    expect(off).not.toContain("Fixture summary");
  });

  test("空同然の ai-title は保存しない（先頭から読んだときは題名を消す null）。相づち＋本文は相づちをはがす", async () => {
    expect(titleOf(await read(write([{ type: "ai-title", sessionId: SID, aiTitle: "OK" }])))).toBe(
      null,
    );
    rmSync(dir, { recursive: true, force: true });
    const pasted = write([
      { type: "ai-title", sessionId: SID, aiTitle: '<pasted_content id="c7b5">' },
    ]);
    expect(titleOf(await read(pasted))).toBe(null);
    rmSync(dir, { recursive: true, force: true });
    const ack = write([{ type: "ai-title", sessionId: SID, aiTitle: "OK。コミットしておいて" }]);
    expect(titleOf(await read(ack))).toBe("コミットしておいて");
  });

  test("題名を消す null は先頭からの読み直しのときだけ。続きの追記では題名に触れない", () => {
    const d = write([{ type: "ai-title", sessionId: SID, aiTitle: '<pasted_content id="c7b5">' }]);
    const path = join(d, "projects", "-fixture-repo-e", `${SID}.jsonl`);
    const stream = { key: "x", kind: "jsonl" as const, path, priority: "recent" as const };
    const ctx = fixtureCtx({ privacy: { storeTitles: true } });
    const seen = (ev: NormalizedEvent[]) => ev.find((e) => e.kind === "session_seen");
    const first = readTranscript(CLAUDE_CODE, 5, stream, null, ctx);
    const s1 = seen(first.events);
    expect(s1 && "title" in s1 ? s1.title : "absent").toBeNull();
    // 追記（同じ空同然の題名の行がもう 1 つ）: 続きの読みでは title を出さない
    writeFileSync(
      path,
      `${JSON.stringify({ type: "ai-title", sessionId: SID, aiTitle: "OK" })}\n`,
      { flag: "a" },
    );
    const next = readTranscript(CLAUDE_CODE, 5, stream, first.next, ctx);
    const s2 = seen(next.events);
    expect(s2).toBeDefined();
    expect(s2 && "title" in s2).toBe(false);
  });

  test("空同然の summary は飛ばして ai-title を使う", async () => {
    const d = write([
      { type: "ai-title", sessionId: SID, aiTitle: "Fixture ai title" },
      { type: "summary", summary: "ok", leafUuid: "e0000000-0000-4000-8000-0000000000f1" },
    ]);
    expect(titleOf(await read(d))).toBe("Fixture ai title");
  });
});
