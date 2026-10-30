/**
 * 報告（ADR 0021）: 型の検証（3 つの口で同じ）と report アダプタ。文はすべて合成
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import report from "../src/adapters/report/index.ts";
import type { HookEvent, NormalizedEvent, SessionSeenEvent, TurnEvent } from "../src/index.ts";
import {
  fromReportSpoolLine,
  isOpenableReportUrl,
  parseReport,
  REPORT_LIMITS,
  reportSpoolName,
  reportSpoolText,
  toReportSpoolLine,
} from "../src/report.ts";
import {
  FIXTURE_NOW,
  fixtureCtx,
  readAll,
  rootFor,
  runGoldenSuite,
  runIncrementalSuite,
  runSentinelSuite,
} from "../src/testing/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures/report");
const M = 60_000;
const DETAIL = fixtureCtx({ privacy: { storeTitles: true, storeDetails: true } });

runGoldenSuite(report, FIXTURES, { ctx: DETAIL });
runIncrementalSuite(report, FIXTURES, { ctx: DETAIL });
runSentinelSuite(report, FIXTURES);

const turns = (ev: NormalizedEvent[]) => ev.filter((e): e is TurnEvent => e.kind === "turn");

describe("parseReport", () => {
  const ok = { source: "myscript", id: "job-1", state: "started" as const };
  test("最小の報告と、すべての項目", () => {
    expect(parseReport(ok)).toEqual({ ok: true, report: ok });
    const full = {
      ...ok,
      state: "waiting",
      title: "Nightly export",
      project: "Reports",
      wait: { kind: "question", text: "Overwrite?", options: ["Yes", "No"] },
      url: "https://example.com/x",
      at: 1_790_000_000_000,
      client_id: "0192a3b4-0000-7000-8000-000000000001",
    };
    expect(parseReport(full)).toEqual({ ok: true, report: full as never });
  });
  test.each([
    [{ ...ok, source: "A" }, "source"],
    [{ ...ok, source: "x" }, "source"],
    [{ ...ok, source: "claude_code" }, "source"],
    [{ ...ok, source: "codex" }, "source"],
    [{ ...ok, id: "" }, "id"],
    [{ ...ok, id: "x".repeat(129) }, "id"],
    [{ ...ok, state: "paused" }, "state"],
    [{ ...ok, state: "waiting" }, "wait"],
    [{ ...ok, wait: { kind: "question", text: "q" } }, "wait"],
    [{ ...ok, state: "waiting", wait: { kind: "ask", text: "q" } }, "wait.kind"],
    [{ ...ok, state: "waiting", wait: { kind: "question", text: " " } }, "wait.text"],
    [{ ...ok, state: "waiting", wait: { kind: "question", text: "q", body: "x" } }, "wait.body"],
    [{ ...ok, error: { kind: "timeout" } }, "error"],
    [{ ...ok, state: "error", error: { kind: "has space" } }, "error.kind"],
    [{ ...ok, url: "file:///etc/hosts" }, "url"],
    [{ ...ok, url: "javascript:alert(1)" }, "url"],
    [{ ...ok, at: -1 }, "at"],
    [{ ...ok, client_id: "not ok!" }, "client_id"],
    [{ ...ok, message: "hello" }, "message"],
    ["x", "body"],
  ])("だめな報告は項目の名前だけ: %j → %s", (v, field) => {
    expect(parseReport(v)).toEqual({ ok: false, field });
  });
  test("文は上限で切り、改行・制御文字は空白にする", () => {
    const r = parseReport({
      ...ok,
      state: "waiting",
      title: "t".repeat(200),
      wait: {
        kind: "question",
        text: `line1\nline2\u0007${"q".repeat(400)}`,
        options: Array.from({ length: 15 }, (_, i) => `${i}`.repeat(80)),
        label: "l".repeat(100),
      },
    });
    if (!r.ok) throw new Error(r.field);
    expect(r.report.title).toHaveLength(REPORT_LIMITS.title);
    expect(r.report.wait?.text.startsWith("line1 line2 ")).toBe(true);
    expect(r.report.wait?.text).toHaveLength(REPORT_LIMITS.text);
    expect(r.report.wait?.options).toHaveLength(REPORT_LIMITS.options);
    expect(r.report.wait?.options?.[0]).toHaveLength(REPORT_LIMITS.option);
    expect(r.report.wait?.label).toHaveLength(REPORT_LIMITS.label);
  });
  test("開く先は http(s) とアプリの URL スキームだけ", () => {
    expect(isOpenableReportUrl("https://example.com/a?b=1")).toBe(true);
    expect(isOpenableReportUrl("myapp://open/42")).toBe(true);
    expect(isOpenableReportUrl("file:///tmp/x")).toBe(false);
    expect(isOpenableReportUrl("data:text/html,x")).toBe(false);
    expect(isOpenableReportUrl("turnlane://x")).toBe(false);
    expect(isOpenableReportUrl("https://")).toBe(false);
    expect(isOpenableReportUrl("no scheme")).toBe(false);
  });
  test("spool の 1 行に往復し、4 KB 未満に収める", () => {
    const r = parseReport({
      ...ok,
      state: "waiting",
      wait: { kind: "question", text: "Overwrite?", options: ["Yes"] },
    });
    if (!r.ok) throw new Error(r.field);
    const line = toReportSpoolLine(r.report, 5, "cid-1");
    const text = reportSpoolText(line);
    expect(text?.endsWith("\n")).toBe(true);
    expect(fromReportSpoolLine(JSON.parse(text ?? "{}"))).toEqual({
      receivedAt: 5,
      clientId: "cid-1",
      report: { ...r.report, client_id: "cid-1" },
    });
    const big = toReportSpoolLine(
      {
        ...r.report,
        title: "あ".repeat(120),
        wait: {
          kind: "question",
          text: "い".repeat(300),
          options: Array(10).fill("う".repeat(60)),
        },
        url: `https://example.com/${"a".repeat(2000)}`,
      },
      5,
      "cid-2",
    );
    const t2 = reportSpoolText(big);
    expect(t2).not.toBeNull();
    expect(new TextEncoder().encode(t2 ?? "").length).toBeLessThan(REPORT_LIMITS.lineBytes);
  });
  test("spool のファイル名は暦日", () => {
    expect(reportSpoolName(new Date(2026, 9, 1, 12).getTime())).toBe("report-20261001.jsonl");
  });
});

describe("report アダプタ", () => {
  const dir = join(FIXTURES, "v1", "lifecycle");
  test("出どころがセッションの tool、作業の ID が external_id。entrypoint は report", async () => {
    const ev = await readAll(report, rootFor(report, dir), DETAIL);
    const seen = ev.filter((e): e is SessionSeenEvent => e.kind === "session_seen");
    expect([...new Set(seen.map((e) => `${e.ref.tool}:${e.ref.externalId}`))]).toEqual([
      "myscript:export-1",
      "nightly:backup",
      "nightly:sync",
    ]);
    expect(seen.every((e) => e.entrypoint === "report")).toBe(true);
    expect(seen[0]).toMatchObject({ title: "Nightly export", project: "Reports" });
    expect(seen[1]?.openUrl).toBe("https://example.com/runs/1");
  });

  test("started → waiting(question) → running → done は 1 つのターン。再送（同じ client_id）・予約の出どころ・壊れた行は捨てる", async () => {
    const ev = await readAll(report, rootFor(report, dir), DETAIL);
    const t = turns(ev).filter((e) => e.ref.externalId === "export-1");
    expect(new Set(t.map((e) => e.turnKey)).size).toBe(1);
    expect(t.map((e) => [e.status, e.pendingQuestion ?? false])).toEqual([
      ["running", false],
      ["running", true],
      ["running", false],
      ["completed", false],
    ]);
    expect(t[1]?.reportWait).toEqual({
      kind: "question",
      text: "Overwrite last night's file?",
      options: ["Overwrite", "Keep both"],
    });
    expect(t[3]).toMatchObject({
      endedAt: FIXTURE_NOW + 12 * M,
      endedWith: "end_turn",
      initiator: "system",
    });
    expect(ev.some((e) => "ref" in e && e.ref.tool === "claude_code")).toBe(false);
  });

  test("waiting(permission) は許可待ちの hook。error は error で閉じる。始まりの無い done・未来の時刻", async () => {
    const ev = await readAll(report, rootFor(report, dir), DETAIL);
    const hooks = ev.filter((e): e is HookEvent => e.kind === "hook");
    expect(hooks.map((h) => [h.ref.tool, h.name, h.toolName, h.at])).toEqual([
      ["nightly", "PermissionRequest", "Delete snapshots", FIXTURE_NOW + 21 * M],
    ]);
    const b = turns(ev).filter((e) => e.ref.externalId === "backup");
    expect(b.map((e) => [e.status, e.endedWith ?? null, e.closeOpen ?? false])).toEqual([
      ["running", null, true],
      ["running", null, false],
      ["error", "error", false],
      ["running", null, true],
    ]);
    // 未来の時刻は受けた時刻に丸める
    expect(b[3]?.startedAt).toBe(FIXTURE_NOW + 32 * M);
    const s = turns(ev).filter((e) => e.ref.externalId === "sync");
    expect(s[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        startedAt: FIXTURE_NOW + 30 * M,
        endedAt: FIXTURE_NOW + 30 * M,
        closeOpen: true,
      }),
    );
    // 閉じた後の running は新しいターン（余計なキーは許可リストで落ちる）
    expect(s[1]).toMatchObject({ status: "running", closeOpen: true });
    expect(s[1]?.turnKey).not.toBe(s[0]?.turnKey);
  });

  test("待ちの中身・件名は保存の設定のときだけ", async () => {
    const ev = await readAll(
      report,
      rootFor(report, dir),
      fixtureCtx({ privacy: { storeTitles: false, storeDetails: false } }),
    );
    expect(turns(ev).some((e) => e.reportWait)).toBe(false);
    expect(ev.some((e) => e.kind === "session_seen" && e.title)).toBe(false);
  });

  test("出どころ 1 つにつき 1 分 60 件まで（超えた分は捨て、ログは出どころの名前だけ）", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "turnlane-report-"));
    try {
      const lines = Array.from({ length: 70 }, (_, i) =>
        JSON.stringify({
          v: 1,
          kind: "report",
          received_at: FIXTURE_NOW + i * 100,
          client_id: `c${i}`,
          source: "myscript",
          id: `job-${i}`,
          state: "done",
        }),
      );
      writeFileSync(join(tmp, "report-20261001.jsonl"), `${lines.join("\n")}\n`);
      const logged: { event: string; fields: unknown }[] = [];
      const ctx = fixtureCtx({
        log: {
          debug() {},
          info() {},
          error() {},
          warn: (event, fields) => logged.push({ event, fields }),
        },
      });
      const ev = await readAll(report, rootFor(report, tmp), ctx);
      expect(turns(ev)).toHaveLength(60);
      expect(logged).toEqual([{ event: "report.rate_limited", fields: { source: "myscript" } }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
