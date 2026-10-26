import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codex from "../src/adapters/codex/index.ts";
import type { TurnEvent } from "../src/index.ts";
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

const FIXTURES = join(import.meta.dir, "fixtures/codex");

runGoldenSuite(codex, FIXTURES);
runIncrementalSuite(codex, FIXTURES);
runSentinelSuite(codex, FIXTURES);

async function stateOf(caseName: string) {
  const dir = join(FIXTURES, "0.147.x", caseName);
  return reduceEvents(
    await withRootJail([dir], () => readAll(codex, rootFor(codex, dir), fixtureCtx())),
  );
}

describe("codex: パースの規則（ai-session-ingestion 1.4）", () => {
  test("CLI 起動: git のブランチがターンに入り、時間は duration_ms", async () => {
    const st = await stateOf("cli-git");
    const turns = Object.values(st.turns) as Omit<TurnEvent, "kind">[];
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.gitBranch).toBeDefined();
      if (t.status === "completed") expect(typeof t.durationMs).toBe("number");
      expect(t.initiator).toBe("human");
    }
    const s = Object.values(st.sessions)[0];
    expect(s?.entrypoint).toBe("codex-tui");
    expect(s?.noise).toBe(false);
  });

  test("Desktop: guardian はノイズ・親子付け、turn_aborted は中断、archived_sessions はアーカイブ、タイトルは thread_name", async () => {
    const st = await stateOf("desktop-guardian-aborted");
    const sessions = Object.values(st.sessions);
    const guardian = sessions.find((s) => s.isSubagent);
    expect(guardian?.noise).toBe(true);
    expect(guardian?.parent).toBeDefined();
    expect(sessions.filter((s) => s.archived)).toHaveLength(1);
    const turns = Object.values(st.turns) as Omit<TurnEvent, "kind">[];
    expect(turns.some((t) => t.status === "interrupted" && t.endedWith === "aborted")).toBe(true);
    expect(turns.some((t) => (t.editedFiles ?? 0) > 0)).toBe(true);
    expect(sessions.some((s) => s.titleSource === "thread_name")).toBe(true);
    for (const t of turns) expect(t.gitBranch).toBeUndefined();
  });

  test("CODEX_HOME を検出し、SQLite は対象にしない", async () => {
    const home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    try {
      const root = join(home, "codex-home");
      mkdirSync(join(root, "sessions/2026/09/01"), { recursive: true });
      for (const f of ["state_5.sqlite", "auth.json", "session_index.jsonl", "history.jsonl"]) {
        writeFileSync(join(root, f), "");
      }
      writeFileSync(join(root, "sessions/2026/09/01/rollout-x.jsonl"), "");
      const roots = await codex.detect({ home, vars: { CODEX_HOME: root } });
      expect(roots.map((r) => r.rootPath)).toEqual([root]);
      const streams = await codex.listStreams(roots[0] as never, {});
      expect(streams.map((s) => s.key).sort()).toEqual([
        "session_index.jsonl",
        "sessions/2026/09/01/rollout-x.jsonl",
      ]);
      expect(await codex.detect({ home, vars: {} })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("プロジェクト外の会話の cwd は日付までに切り落とし、継続状態にも残さない（D-135。題名を保存しない設定でも）", async () => {
    const home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
    try {
      const root = join(home, ".codex");
      const dir = join(root, "sessions/2026/10/08");
      mkdirSync(dir, { recursive: true });
      const slug = "SENTINEL-plan-the-trip";
      const cwd = join(home, "Documents/Codex/2026-10-08", slug);
      const sid = "00000000-0000-4000-8000-000000000135";
      const lines = [
        {
          type: "session_meta",
          timestamp: "2026-10-08T01:00:00.000Z",
          payload: {
            id: sid,
            timestamp: "2026-10-08T01:00:00.000Z",
            cwd,
            originator: "Codex Desktop",
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-10-08T01:00:01.000Z",
          payload: { type: "task_started", turn_id: "t1", started_at: 1791421201 },
        },
        {
          type: "turn_context",
          timestamp: "2026-10-08T01:00:01.100Z",
          payload: { turn_id: "t1", cwd: `${cwd}/sub` },
        },
      ];
      const path = join(dir, `rollout-2026-10-08T10-00-00-${sid}.jsonl`);
      writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      for (const storeTitles of [true, false]) {
        const r = await codex.read(
          {
            key: `sessions/2026/10/08/rollout-2026-10-08T10-00-00-${sid}.jsonl`,
            kind: "jsonl",
            path,
            priority: "live",
          },
          null,
          fixtureCtx({ home, privacy: { storeTitles } }),
        );
        const out = JSON.stringify({ events: r.events, next: r.next });
        expect(out).not.toContain("SENTINEL");
        const cwds = r.events.flatMap((e) => ("cwd" in e && e.cwd ? [e.cwd] : []));
        expect(cwds.length).toBeGreaterThan(0);
        for (const c of cwds) expect(c).toBe(join(home, "Documents/Codex/2026-10-08"));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
